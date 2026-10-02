include $(TOPDIR)/rules.mk

PKG_NAME:=unblockneteasemusic-stage9
PKG_VERSION:=0.28.0
PKG_RELEASE:=$(if $(UNM_PKG_RELEASE),$(UNM_PKG_RELEASE),1)
PKG_LICENSE:=LGPL-3.0-only
PKG_MAINTAINER:=Lomiry
PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)

include $(INCLUDE_DIR)/package.mk

define Package/unblockneteasemusic-stage9
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Stage 9 optimized UNM core for ImmortalWrt
  URL:=https://github.com/Lomiry/unlockmusic163
  EXTRA_DEPENDS:=node (>= 12), luci-app-unblockneteasemusic (>= 0)
endef

define Package/unblockneteasemusic-stage9/description
  XEAPI privilege and player URL fallback for Android Netease Music 9.6.05.
  Uses the existing LuCI service, certificates and routing configuration.
  Run unm-stage9 activate after installing; unm-stage9 rollback restores the backup.
endef

define Package/unblockneteasemusic-stage9/conffiles
/etc/unblockneteasemusic-stage9/
endef

define Build/Prepare
	$(INSTALL_DIR) $(PKG_BUILD_DIR)
	$(CP) ./payload $(PKG_BUILD_DIR)/
endef

define Build/Configure
endef

define Build/Compile
endef

define Package/unblockneteasemusic-stage9/install
	$(INSTALL_DIR) $(1)/usr/share/unblockneteasemusic-stage9
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/payload/* $(1)/usr/share/unblockneteasemusic-stage9/
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) ./files/unm-stage9 $(1)/usr/bin/unm-stage9
endef

define Package/unblockneteasemusic-stage9/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
echo 'Stage 9 core installed. Run: unm-stage9 activate'
exit 0
endef

$(eval $(call BuildPackage,unblockneteasemusic-stage9))
