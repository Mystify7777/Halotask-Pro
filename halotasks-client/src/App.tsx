import { createContext, useContext } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import AppLayout from './components/AppLayout';
import ProtectedRoute from './components/ProtectedRoute';
import SmartEntryGate from './components/SmartEntryGate';
import DashboardPage from './pages/DashboardPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import NotFoundPage from './pages/NotFoundPage';
import RegisterPage from './pages/RegisterPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import { useAdaptiveTheme, type UseAdaptiveThemeReturn } from './theme';

const ThemeContext = createContext<UseAdaptiveThemeReturn | null>(null);

export function useTheme(): UseAdaptiveThemeReturn {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <App>');
  return ctx;
}

export default function App() {
  const themeControls = useAdaptiveTheme();

  return (
    <ThemeContext.Provider value={themeControls}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<SmartEntryGate />} />
          <Route path="/home" element={<HomePage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <AppLayout>
                  <DashboardPage />
                </AppLayout>
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </BrowserRouter>
    </ThemeContext.Provider>
  );
}
