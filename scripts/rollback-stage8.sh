#!/bin/sh
set -eu
core=/usr/share/unblockneteasemusic/core/app.js
init=/etc/init.d/unblockneteasemusic
printf '%s  %s\n' '51a87abe4d6f53903c1b5372d24c6e1cb2d74b7186a1ab0e6b3af6301a893b17' "$core" | sha256sum -c -
printf '%s  %s\n' 'cf2962cefa4f487e69058ab40b7aaf12cfd06901cab54947ea28bbd461514f9f' "$core.before-stage9" | sha256sum -c -
test -f "$init.before-stage9"
sh -n "$init.before-stage9"
test ! -e "$core.stage9-before-rollback"
test ! -e "$init.stage9-before-rollback"
test ! -e "$core.next-stage9-rollback"
test ! -e "$init.next-stage9-rollback"
cp -p "$core" "$core.stage9-before-rollback"
cp -p "$init" "$init.stage9-before-rollback"
cp -p "$core.before-stage9" "$core.next-stage9-rollback"
cp -p "$init.before-stage9" "$init.next-stage9-rollback"
printf '%s  %s\n' 'cf2962cefa4f487e69058ab40b7aaf12cfd06901cab54947ea28bbd461514f9f' "$core.next-stage9-rollback" | sha256sum -c -
/etc/init.d/unblockneteasemusic stop
mv "$core.next-stage9-rollback" "$core"
mv "$init.next-stage9-rollback" "$init"
/etc/init.d/unblockneteasemusic start
printf '%s  %s\n' 'cf2962cefa4f487e69058ab40b7aaf12cfd06901cab54947ea28bbd461514f9f' "$core" | sha256sum -c -
