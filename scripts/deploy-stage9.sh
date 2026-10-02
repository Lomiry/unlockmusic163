#!/bin/sh
set -eu
core=/usr/share/unblockneteasemusic/core/app.js
init=/etc/init.d/unblockneteasemusic
new=/tmp/app.js.stage9
old=cf2962cefa4f487e69058ab40b7aaf12cfd06901cab54947ea28bbd461514f9f
newsha=51a87abe4d6f53903c1b5372d24c6e1cb2d74b7186a1ab0e6b3af6301a893b17
printf '%s  %s\n' "$old" "$core" | sha256sum -c -
printf '%s  %s\n' "$newsha" "$new" | sha256sum -c -
node --check < "$new"
test ! -e "$core.before-stage9"
test ! -e "$init.before-stage9"
test ! -e "$core.next-stage9"
test ! -e "$init.next-stage9"
test "$(grep -c 'procd_append_param env LOG_LEVEL=' "$init")" -eq 1
grep -q 'UNM_XEAPI_PRIVILEGE_PATCH=true' "$init"
if grep -q 'UNM_XEAPI_PLAYER_URL_PATCH=' "$init"; then
    echo 'Stage 9 environment already exists; inspect init before deployment.' >&2
    exit 1
fi
cp -p "$core" "$core.before-stage9"
cp -p "$init" "$init.before-stage9"
printf '%s  %s\n' "$old" "$core.before-stage9" | sha256sum -c -
cp "$new" "$core.next-stage9"
chmod 644 "$core.next-stage9"
sed -e 's/UNM_ALBUM_PLAY_OBSERVER=true/UNM_ALBUM_PLAY_OBSERVER=false/g' -e '/procd_append_param env LOG_LEVEL=/a\
procd_append_param env UNM_XEAPI_PLAYER_URL_PATCH=false UNM_XEAPI_PLAYER_URL_PATCH_LOG_FILE=/var/run/unblockneteasemusic/xeapi-player-url-patch.log # UNM_STAGE9' "$init" > "$init.next-stage9"
chmod 755 "$init.next-stage9"
sh -n "$init.next-stage9"
grep -q 'UNM_XEAPI_PRIVILEGE_PATCH=true' "$init.next-stage9"
printf '%s  %s\n' "$newsha" "$core.next-stage9" | sha256sum -c -
/etc/init.d/unblockneteasemusic stop
mv "$core.next-stage9" "$core"
mv "$init.next-stage9" "$init"
/etc/init.d/unblockneteasemusic start
printf '%s  %s\n' "$newsha" "$core" | sha256sum -c -
echo 'Stage 9 installed OFF; Stage 6 retained; observer OFF.'
