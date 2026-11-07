#!/bin/bash
set -e
[ -f android/app/build.gradle ] || { echo '找不到 android/app/build.gradle（可能不是預期的專案格式）'; exit 1; }
M=android/app/src/main/AndroidManifest.xml
sed -i -E 's/minSdkVersion = [0-9]+/minSdkVersion = 26/' android/variables.gradle
sed -i 's|<application|<uses-permission android:name="android.permission.CAMERA"/>\n    <uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>\n    <uses-permission android:name="android.permission.health.READ_HEALTH_DATA_HISTORY"/>\n    <application|' "$M"

# --- 固定簽章：直接寫進 Gradle 設定，不依賴 ~/.android ---
cp debug.keystore android/app/debug.keystore
cat >> android/app/build.gradle <<'GRADLE'

android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
}
GRADLE

# --- 版本號：用「從 1970 年起算的分鐘數」，一定比上一次打包大 ---
# 舊做法用 GITHUB_RUN_NUMBER，換新 repo 會從 1 重算，手機會拒絕「降版」安裝。
# 分鐘數目前約 2,960 萬，遠大於舊版用過的數字，而且不管換哪個 repo 都會一直變大（上限 21 億，可用到西元 5000 年後）。
VC=$(( $(date +%s) / 60 ))
VN="$(TZ=Asia/Taipei date +%Y.%m.%d.%H%M)"
sed -i -E "s/versionCode [0-9]+/versionCode ${VC}/" android/app/build.gradle
sed -i -E "s/versionName \"[^\"]*\"/versionName \"${VN}\"/" android/app/build.gradle
echo "versionCode=${VC} versionName=${VN}"
echo "版本號：${VN}（versionCode ${VC}）" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

# --- 背景執行外掛需要的 Gradle 設定（官方文件：flatDir 加入外掛的 libs 資料夾）---
BR_DIR="'../../node_modules/@capacitor/background-runner/android/src/main/libs'"
if grep -q "capacitor-cordova-android-plugins/src/main/libs" android/app/build.gradle; then
  sed -i "s|dirs '../capacitor-cordova-android-plugins/src/main/libs', 'libs'|&\n        dirs ${BR_DIR}, 'libs'|" android/app/build.gradle
else
  printf "\nrepositories {\n    flatDir {\n        dirs %s, 'libs'\n    }\n}\n" "$BR_DIR" >> android/app/build.gradle
fi
