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

# --- 每次打包版本號遞增，確保一定是「更新」而不是同版本或降版 ---
sed -i -E "s/versionCode [0-9]+/versionCode ${GITHUB_RUN_NUMBER:-1}/" android/app/build.gradle

# --- 背景執行外掛需要的 Gradle 設定（官方文件：flatDir 加入外掛的 libs 資料夾）---
BR_DIR="'../../node_modules/@capacitor/background-runner/android/src/main/libs'"
if grep -q "capacitor-cordova-android-plugins/src/main/libs" android/app/build.gradle; then
  sed -i "s|dirs '../capacitor-cordova-android-plugins/src/main/libs', 'libs'|&\n        dirs ${BR_DIR}, 'libs'|" android/app/build.gradle
else
  printf "\nrepositories {\n    flatDir {\n        dirs %s, 'libs'\n    }\n}\n" "$BR_DIR" >> android/app/build.gradle
fi
