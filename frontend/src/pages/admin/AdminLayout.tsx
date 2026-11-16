import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, Link, useNavigate, useLocation } from "react-router-dom";
import { Flex, Text, Theme } from "@radix-ui/themes";
import { Activity, LogOut, Menu, X, Home, Github, Palette, Sun, Moon, Laptop } from "lucide-react";
import { Button } from "../../components/ui/minimal";
import { useAuth } from "../../contexts/AuthContext";
import { useTheme } from "../../contexts/ThemeContext";
import { useDisplayTheme } from "../../contexts/DisplayThemeContext";
import { displayThemeLabels, getNextDisplayTheme, normalizeDisplayTheme } from "../../utils/displayTheme";
import { CF_MONITOR_GITHUB_URL } from "../../utils/projectLinks";
import { formatAppVersion } from "../../utils/version";
import {
  adminMenuItems,
  isAdminMenuPathActive,
} from "./adminMenu";

export default function AdminLayout() {
  const { isAuthenticated, authLoading, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const { displayTheme, setDisplayTheme, toggleDisplayTheme } = useDisplayTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const githubUrl = CF_MONITOR_GITHUB_URL;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 768px)').matches);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement | null>(null);
  const [version, setVersion] = useState("dev");
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const logoutPendingRef = useRef(false);
  const closeSidebar = useCallback(() => {
    if (!isMobile) return;
    setSidebarOpen(false);
    requestAnimationFrame(() => sidebarToggleRef.current?.focus());
  }, [isMobile]);

  useEffect(() => {
    document.getElementById('cf-monitor-active-theme-css')?.remove();
  }, []);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate("/login", {
        replace: true,
        state: { from: `${location.pathname}${location.search}` },
      });
    }
  }, [authLoading, isAuthenticated, location.pathname, location.search, navigate]);

  useEffect(() => {
    fetch("/api/version")
      .then((r) => r.json())
      .then((data) => {
        if (data.version) setVersion(formatAppVersion(data.version));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    const preloadSettings = () => {
      void import("./SettingsLayout");
      void import("./SettingsSite");
      void import("./SettingsGeneral");
    };
    const idleId = window.requestIdleCallback
      ? window.requestIdleCallback(preloadSettings)
      : window.setTimeout(preloadSettings, 0);
    return () => {
      if (window.cancelIdleCallback) window.cancelIdleCallback(idleId);
      else window.clearTimeout(idleId);
    };
  }, [isAuthenticated]);

  // responsive sidebar
  useEffect(() => {
    const media = window.matchMedia('(max-width: 768px)');
    const handleResize = () => {
      setIsMobile(media.matches);
      setSidebarOpen(!media.matches);
    };
    handleResize();
    media.addEventListener('change', handleResize);
    return () => media.removeEventListener('change', handleResize);
  }, []);

  useEffect(() => {
    if (authLoading || !isAuthenticated || !isMobile || !sidebarOpen) return;
    const controls = () => Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex="0"]') || [])
      .filter(element => element.getClientRects().length > 0);
    const frame = requestAnimationFrame(() => controls()[0]?.focus());
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSidebar();
      } else if (event.key === 'Tab') {
        const items = controls();
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;
        if (!sidebarRef.current?.contains(document.activeElement) || (!event.shiftKey && document.activeElement === last)) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKey);
    };
  }, [authLoading, closeSidebar, isAuthenticated, isMobile, sidebarOpen]);

  if (authLoading) {
    return (
      <Flex align="center" justify="center" style={{ minHeight: "100vh" }}>
        <Text size="2" color="gray">加载中…</Text>
      </Flex>
    );
  }

  if (!isAuthenticated) return null;

  const handleLogout = async () => {
    if (logoutPendingRef.current) return;
    logoutPendingRef.current = true;
    setLoggingOut(true);
    setLogoutError(null);
    const currentDisplayTheme = normalizeDisplayTheme(document.documentElement.getAttribute("data-monitor-theme") || displayTheme);
    setDisplayTheme(currentDisplayTheme);
    try {
      await logout();
      navigate("/login", { replace: true });
    } catch (error) {
      setLogoutError(`退出尚未确认，登录状态已保留。${error instanceof Error ? error.message : '网络错误'}。请重试退出。`);
      closeSidebar();
    } finally {
      logoutPendingRef.current = false;
      setLoggingOut(false);
    }
  };

  const cycleTheme = () => {
    const themes: Array<"light" | "dark" | "system"> = ["light", "dark", "system"];
    const idx = themes.indexOf(theme);
    setTheme(themes[(idx + 1) % themes.length]);
  };

  const openGithub = () => {
    if (!githubUrl) return;
    window.open(githubUrl, "_blank", "noopener,noreferrer");
  };

  const openPublicSite = () => {
    window.open("/", "_blank", "noopener,noreferrer");
  };

  const themeIcon =
    theme === "dark" ? <Moon size={18} /> : theme === "light" ? <Sun size={18} /> : <Laptop size={18} />;
  const nextDisplayTheme = displayThemeLabels[getNextDisplayTheme(displayTheme)];
  const nextThemeLabel =
    theme === "light" ? "切换成深色模式" : theme === "dark" ? "切换成跟随系统" : "切换成浅色模式";

  return (
    <Theme accentColor="gray" grayColor="slate" radius="medium" panelBackground="solid" className="sa-scope sa-shell">
    <div className="admin-shell">
      {/* Mobile overlay */}
      {sidebarOpen && isMobile && (
        <div className="mobile-sidebar-overlay" onClick={closeSidebar} />
      )}

      {/* Mobile toggle button */}
      <button
        type="button"
        ref={sidebarToggleRef}
        className={`admin-icon-button mobile-sidebar-toggle${sidebarOpen ? " is-open" : ""}`}
        onClick={() => sidebarOpen ? closeSidebar() : setSidebarOpen(true)}
        aria-controls="admin-sidebar"
        aria-expanded={sidebarOpen}
        aria-label={sidebarOpen ? "关闭菜单" : "打开菜单"}
        title={sidebarOpen ? "关闭菜单" : "打开菜单"}
      >
        {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
      </button>

      {/* Sidebar */}
      <aside ref={sidebarRef} id="admin-sidebar" className={`admin-sidebar ${sidebarOpen ? "open" : ""}`}
        {...(isMobile && !sidebarOpen ? { inert: '' } : {})}
        aria-hidden={isMobile && !sidebarOpen || undefined}
        role={isMobile ? 'dialog' : undefined}
        aria-modal={isMobile && sidebarOpen || undefined}
        aria-label={isMobile ? '管理菜单' : undefined}
      >
        <div className="admin-sidebar-header">
          <span className="admin-brand-mark" aria-hidden="true"><Activity size={16} /></span>
          <div className="admin-brand-text">
            <span className="admin-brand-name">CF VPS Monitor</span>
            <span className="admin-brand-sub">管理后台</span>
          </div>
          {isMobile && (
            <button type="button" className="admin-icon-button admin-sidebar-close" onClick={closeSidebar} aria-label="关闭菜单">
              <X size={16} />
            </button>
          )}
        </div>

        <nav className="admin-sidebar-nav">
          {adminMenuItems.map((item) => {
            const active = isAdminMenuPathActive(item.path, location.pathname);
            const content = (
              <>
                {item.icon}
                <span>{item.label}</span>
              </>
            );
            if (item.external) {
              return (
                <a
                  key={item.path}
                  href={item.path}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={closeSidebar}
                  className="admin-menu-item"
                >
                  {content}
                </a>
              );
            }
            return (
              <Link
                key={item.path}
                to={item.path}
                onClick={closeSidebar}
                className={`admin-menu-item${active ? " active" : ""}`}
                aria-current={active ? "page" : undefined}
              >
                {content}
              </Link>
            );
          })}
        </nav>

        <div className="admin-sidebar-footer">
          <Button variant="outline" size="sm" className="admin-sidebar-action" onClick={openPublicSite}>
            <Home size={14} /> 返回前台
          </Button>
          <Button variant="outline" size="sm" className="admin-sidebar-action admin-sidebar-logout" onClick={() => void handleLogout()} disabled={loggingOut}>
            <LogOut size={14} /> {loggingOut ? '退出中…' : '退出登录'}
          </Button>
          <button type="button" className="admin-sidebar-version" onClick={() => { closeSidebar(); navigate("/admin/about"); }}>
            {version}
          </button>
        </div>
      </aside>

      <main className="admin-main" {...(isMobile && sidebarOpen ? { inert: '' } : {})}>
        <div className="admin-main-content">
          <div className="admin-top-actions" aria-label="后台快捷操作">
            <button
              type="button"
              className="admin-icon-button admin-top-action-button"
              onClick={openGithub}
              aria-label={githubUrl ? "打开 GitHub" : "GitHub 链接待添加"}
              aria-disabled={!githubUrl}
              title={githubUrl ? "打开 GitHub" : "GitHub 链接待添加"}
            >
              <Github size={18} />
            </button>
            <button
              type="button"
              className="admin-icon-button admin-top-action-button"
              onClick={toggleDisplayTheme}
              aria-label={`切换成 ${nextDisplayTheme} 主题`}
              title={`切换成 ${nextDisplayTheme} 主题`}
            >
              <Palette size={18} />
            </button>
            <button
              type="button"
              className="admin-icon-button admin-top-action-button"
              onClick={cycleTheme}
              aria-label={nextThemeLabel}
              title={nextThemeLabel}
            >
              {themeIcon}
            </button>
            <button
              type="button"
              className="admin-icon-button admin-top-action-button"
              onClick={openPublicSite}
              aria-label="返回前台"
              title="返回前台"
            >
              <Home size={18} />
            </button>
          </div>
          {logoutError && <div className="sa-alert admin-logout-error" role="alert">
            <span>{logoutError}</span>
            <Button variant="outline" size="sm" disabled={loggingOut} onClick={() => void handleLogout()}>重试退出</Button>
          </div>}
          <Outlet />
        </div>
      </main>

    </div>
    </Theme>
  );
}
