#!/bin/sh
set -eu
core=/usr/share/unblockneteasemusic/core/app.js
new=/tmp/app.js.stage9
old=d8b0171e346f6655985669896197d5a65bc66afb7b783cc28af4b4c5370fdace
newsha=51a87abe4d6f53903c1b5372d24c6e1cb2d74b7186a1ab0e6b3af6301a893b17
printf '%s  %s\n' "$old" "$core" | sha256sum -c -
printf '%s  %s\n' "$newsha" "$new" | sha256sum -c -
node --check < "$new"
test ! -e "$core.before-stage9-performance"
test ! -e "$core.next-stage9-performance"
cp -p "$core" "$core.before-stage9-performance"
printf '%s  %s\n' "$old" "$core.before-stage9-performance" | sha256sum -c -
cp "$new" "$core.next-stage9-performance"
chmod 644 "$core.next-stage9-performance"
printf '%s  %s\n' "$newsha" "$core.next-stage9-performance" | sha256sum -c -
/etc/init.d/unblockneteasemusic stop
mv "$core.next-stage9-performance" "$core"
/etc/init.d/unblockneteasemusic start
printf '%s  %s\n' "$newsha" "$core" | sha256sum -c -
