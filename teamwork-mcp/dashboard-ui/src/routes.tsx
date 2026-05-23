import { Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import DashboardPage from "@/pages/DashboardPage";
import HistoryPage from "@/pages/HistoryPage";
import SessionPage from "@/pages/SessionPage";
import NotFoundPage from "@/pages/NotFoundPage";

export function AppRoutes(): JSX.Element {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/sessions" element={<DashboardPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/sessions/:sessionId" element={<SessionPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
