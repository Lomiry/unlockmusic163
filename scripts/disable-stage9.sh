#!/bin/sh
set -eu
init=/etc/init.d/unblockneteasemusic
core=/usr/share/unblockneteasemusic/core/app.js
printf '%s  %s\n' '51a87abe4d6f53903c1b5372d24c6e1cb2d74b7186a1ab0e6b3af6301a893b17' "$core" | sha256sum -c -
grep -q 'UNM_XEAPI_PRIVILEGE_PATCH=true' "$init"
test "$(grep -c 'UNM_XEAPI_PLAYER_URL_PATCH=true' "$init")" -eq 1
test ! -e "$init.before-stage9-disable"
test ! -e "$init.next-stage9-disable"
cp -p "$init" "$init.before-stage9-disable"
sed 's/UNM_XEAPI_PLAYER_URL_PATCH=true/UNM_XEAPI_PLAYER_URL_PATCH=false/g' "$init" > "$init.next-stage9-disable"
chmod 755 "$init.next-stage9-disable"
sh -n "$init.next-stage9-disable"
grep -q 'UNM_XEAPI_PRIVILEGE_PATCH=true' "$init.next-stage9-disable"
mv "$init.next-stage9-disable" "$init"
/etc/init.d/unblockneteasemusic restart
