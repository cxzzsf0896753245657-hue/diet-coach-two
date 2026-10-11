#!/bin/bash
# 檢查 APK 實際簽章是否等於 repo 裡的 debug.keystore；不一致就讓打包失敗，避免產出裝不上的 APK
APK=android/app/build/outputs/apk/debug/app-debug.apk
SDK=${ANDROID_HOME:-$ANDROID_SDK_ROOT}
AS=$(ls -d "$SDK"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1)
EXP=$(keytool -list -keystore debug.keystore -storepass android 2>/dev/null | grep -i "SHA-256" | sed 's/.*: //' | tr -d ':' | tr 'A-Z' 'a-z')
echo "固定簽章檔 SHA-256：$EXP"
[ -f "$APK" ] || { echo "找不到 APK：$APK"; exit 1; }
if [ -z "$AS" ]; then echo "找不到 apksigner，無法檢查（略過）"; exit 0; fi
GOT=$("$AS" verify --print-certs "$APK" 2>/dev/null | grep -i "SHA-256 digest" | head -1 | sed 's/.*: //' | tr 'A-Z' 'a-z')
echo "APK 實際簽章 SHA-256：$GOT"
if [ -n "$GOT" ] && [ "$EXP" = "$GOT" ]; then
  echo "==> 簽章一致（OK）"; echo "簽章一致：$GOT" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"; exit 0
fi
echo "==> 簽章「不一致」：這個 APK 沒有使用固定簽章，不能用來更新。"; echo "簽章不一致" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"; exit 1
