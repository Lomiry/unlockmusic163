#!/bin/sh
set -eu
init=/etc/init.d/unblockneteasemusic
core=/usr/share/unblockneteasemusic/core/app.js
printf '%s  %s\n' 'd8b0171e346f6655985669896197d5a65bc66afb7b783cc28af4b4c5370fdace' "$core" | sha256sum -c -
grep -q 'UNM_XEAPI_PRIVILEGE_PATCH=true' "$init"
test "$(grep -c 'UNM_XEAPI_PLAYER_URL_PATCH=false' "$init")" -eq 1
test ! -e "$init.before-stage9-enable"
test ! -e "$init.next-stage9-enable"
cp -p "$init" "$init.before-stage9-enable"
sed 's/UNM_XEAPI_PLAYER_URL_PATCH=false/UNM_XEAPI_PLAYER_URL_PATCH=true/g' "$init" > "$init.next-stage9-enable"
chmod 755 "$init.next-stage9-enable"
sh -n "$init.next-stage9-enable"
grep -q 'UNM_XEAPI_PRIVILEGE_PATCH=true' "$init.next-stage9-enable"
mv "$init.next-stage9-enable" "$init"
/etc/init.d/unblockneteasemusic restart
