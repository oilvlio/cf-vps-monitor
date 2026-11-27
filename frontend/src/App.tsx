import React, { Suspense, lazy } from 'react';
import { Navigate, Routes, Route, useParams } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { DisplayThemeProvider } from './contexts/DisplayThemeContext';
import { LiveDataProvider } from './contexts/LiveDataContext';
import Loading from './components/Loading';
import ErrorBoundary from './components/ErrorBoundary';
import { PUBLIC_DATA_READY_EVENT } from './utils/publicDataEvents';
import { getSessionStorageItem } from './utils/browserStorage';
import { AUTH_USER_STORAGE_KEY } from './contexts/auth-state';

const loadLayout = () => import('./pages/Layout');
const loadIndex = () => import('./pages/Index');
const loadInstance = () => import('./pages/Instance');
const loadLogin = () => import('./pages/Login');
const loadDbInit = () => import('./pages/DbInit');
const loadNotFound = () => import('./pages/NotFound');
const loadAdminDashboard = () => import('./pages/admin/Dashboard');
const loadSettingsLayout = () => import('./pages/admin/SettingsLayout');
const loadSettingsSite = () => import('./pages/admin/SettingsSite');
const loadSettingsGeneral = () => import('./pages/admin/SettingsGeneral');

const Layout = lazy(loadLayout);
const Index = lazy(loadIndex);
const Instance = lazy(loadInstance);
const Login = lazy(loadLogin);
const DbInit = lazy(loadDbInit);
const NotFound = lazy(loadNotFound);

const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'));
const AdminDashboard = lazy(loadAdminDashboard);
const SettingsLayout = lazy(loadSettingsLayout);
const SettingsSite = lazy(loadSettingsSite);
const SettingsGeneral = lazy(loadSettingsGeneral);
const AdminPingTasks = lazy(() => import('./pages/admin/PingTasks'));
const AdminNotifications = lazy(() => import('./pages/admin/Notifications'));
const AdminThemes = lazy(() => import('./pages/admin/Themes'));
const AdminLogs = lazy(() => import('./pages/admin/AuditLogs'));
const AdminAccount = lazy(() => import('./pages/admin/Account'));
const AdminAbout = lazy(() => import('./pages/admin/About'));

const LOGIN_PATHS = new Set(['/login', '/admin/login']);

// 公开页访客只会用到 Layout/Index/Instance，登录页和后台不能在这里预取，
// 否则只看探针首页的人也要为后台 chunk（Dashboard、Notifications 等）付流量。
function preloadPublicRouteChunks() {
  void loadLayout();
  void loadIndex();
  void loadInstance();
}

function preloadAdminRouteChunks() {
  void import('./pages/admin/AdminLayout');
  void loadAdminDashboard();
  void loadSettingsLayout();
  void loadSettingsSite();
  void loadSettingsGeneral();
  void import('./pages/admin/PingTasks');
  void import('./pages/admin/Notifications');
  void import('./pages/admin/Themes');
  void import('./pages/admin/AuditLogs');
  void import('./pages/admin/Account');
  void import('./pages/admin/About');
}

function LiveDataRoute({
  children,
  enabled = true,
}: {
  children: React.ReactNode;
  enabled?: boolean;
}) {
  return <LiveDataProvider enabled={enabled} viewer>{children}</LiveDataProvider>;
}

function PublicIndexRoute() {
  return <Index />;
}

function LegacyNotificationRedirect() {
  const { tab } = useParams<{ tab?: string }>();
  const allowedTabs = new Set(['settings', 'offline', 'expiry', 'load']);
  const targetTab = tab && allowedTabs.has(tab) ? tab : 'settings';
  return <Navigate to={`/admin/notifications/${targetTab}`} replace />;
}

export default function App() {
  React.useEffect(() => {
    const scheduledTasks: Array<{ cancel: () => void }> = [];
    let publicPreloaded = false;
    let adminPreloaded = false;

    const scheduleIdle = (callback: () => void) => {
      if (window.requestIdleCallback) {
        const id = window.requestIdleCallback(callback);
        scheduledTasks.push({ cancel: () => window.cancelIdleCallback(id) });
      } else {
        const id = window.setTimeout(callback, 0);
        scheduledTasks.push({ cancel: () => window.clearTimeout(id) });
      }
    };

    const schedulePublicPreload = () => {
      if (publicPreloaded) return;
      // 登录页 / 后台自己有更重要的 chunk，不必预取公开路由。
      const pathname = window.location.pathname;
      if (LOGIN_PATHS.has(pathname) || pathname.startsWith('/admin') || pathname === '/db-init') return;
      publicPreloaded = true;
      scheduleIdle(preloadPublicRouteChunks);
    };

    const scheduleAdminPreload = () => {
      if (adminPreloaded) return;
      adminPreloaded = true;
      scheduleIdle(preloadAdminRouteChunks);
    };

    // 首屏公开数据就绪（或兜底 30s）后只预取公开路由。
    const timeoutId = window.setTimeout(schedulePublicPreload, 30_000);
    window.addEventListener(PUBLIC_DATA_READY_EVENT, schedulePublicPreload, { once: true });

    // 仅当本地缓存里已有登录态（说明这是回访的后台用户）才预取后台 chunk。
    if (getSessionStorageItem(AUTH_USER_STORAGE_KEY)) scheduleAdminPreload();

    // 登录页上用户开始操作表单时再预取后台 chunk；只看公开页的访客不会触发。
    const handleLoginInteraction = () => {
      if (LOGIN_PATHS.has(window.location.pathname)) scheduleAdminPreload();
    };
    window.addEventListener('focusin', handleLoginInteraction);
    window.addEventListener('pointerdown', handleLoginInteraction);

    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener(PUBLIC_DATA_READY_EVENT, schedulePublicPreload);
      window.removeEventListener('focusin', handleLoginInteraction);
      window.removeEventListener('pointerdown', handleLoginInteraction);
      for (const task of scheduledTasks) task.cancel();
    };
  }, []);

  return (
    <ThemeProvider>
      <DisplayThemeProvider>
        <AuthProvider>
          <ErrorBoundary>
            <Suspense fallback={<Loading fullScreen />}>
              <Routes>
                <Route path="/" element={<Layout />}>
                  <Route index element={<LiveDataRoute><PublicIndexRoute /></LiveDataRoute>} />
                  <Route path="instance/:uuid" element={<LiveDataRoute><Instance /></LiveDataRoute>} />
                </Route>

                <Route path="/login" element={<Login />} />
                <Route path="/admin/login" element={<Login />} />
                <Route path="/db-init" element={<DbInit />} />

                <Route path="/admin" element={<AdminLayout />}>
                  <Route index element={<LiveDataRoute><AdminDashboard /></LiveDataRoute>} />
                  <Route path="clients" element={<Navigate to="/admin" replace />} />
                  <Route path="settings" element={<SettingsLayout />}>
                    <Route index element={<SettingsSite />} />
                    <Route path="site" element={<SettingsSite />} />
                    <Route path="notification" element={<Navigate to="/admin/notifications/settings" replace />} />
                    <Route path="notification/:tab" element={<LegacyNotificationRedirect />} />
                    <Route path="general" element={<SettingsGeneral />} />
                  </Route>
                  <Route path="ping" element={<AdminPingTasks />} />
                  <Route path="notifications" element={<AdminNotifications />} />
                  <Route path="notifications/:tab" element={<AdminNotifications />} />
                  <Route path="notification" element={<Navigate to="/admin/notifications/settings" replace />} />
                  <Route path="notification/:tab" element={<LegacyNotificationRedirect />} />
                  <Route path="themes" element={<AdminThemes />} />
                  <Route path="logs" element={<AdminLogs />} />
                  <Route path="account" element={<AdminAccount />} />
                  <Route path="about" element={<AdminAbout />} />
                </Route>

                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
          <Toaster
            position="bottom-right"
            richColors
            closeButton
            duration={4000}
            style={{ fontFamily: 'inherit' }}
          />
        </AuthProvider>
      </DisplayThemeProvider>
    </ThemeProvider>
  );
}
