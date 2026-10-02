#!/bin/sh
set -eu
core=/usr/share/unblockneteasemusic/core/app.js
printf '%s  %s\n' '51a87abe4d6f53903c1b5372d24c6e1cb2d74b7186a1ab0e6b3af6301a893b17' "$core" | sha256sum -c -
printf '%s  %s\n' 'd8b0171e346f6655985669896197d5a65bc66afb7b783cc28af4b4c5370fdace' "$core.before-stage9-performance" | sha256sum -c -
node --check < "$core.before-stage9-performance"
test ! -e "$core.stage9-performance-before-rollback"
test ! -e "$core.next-stage9-performance-rollback"
cp -p "$core" "$core.stage9-performance-before-rollback"
cp -p "$core.before-stage9-performance" "$core.next-stage9-performance-rollback"
chmod 644 "$core.next-stage9-performance-rollback"
/etc/init.d/unblockneteasemusic stop
mv "$core.next-stage9-performance-rollback" "$core"
/etc/init.d/unblockneteasemusic start
printf '%s  %s\n' 'd8b0171e346f6655985669896197d5a65bc66afb7b783cc28af4b4c5370fdace' "$core" | sha256sum -c -
