import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { CommandPalette } from "@/components/CommandPalette";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export function AppShell(): JSX.Element {
  const [mobileOpen, setMobileOpen] = useState(false);
  // Close the mobile nav on every route change. Without this, tapping a
  // sidebar link inside the dialog navigates but leaves the dialog covering
  // the new page. (Review H23.)
  const location = useLocation();
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);
  return (
    <div className="flex min-h-screen w-full bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenuClick={() => setMobileOpen(true)} />
        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          <Outlet />
        </main>
      </div>

      <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
        <DialogContent className="left-0 top-0 h-full w-72 max-w-none translate-x-0 translate-y-0 rounded-none p-0 sm:rounded-none">
          <DialogTitle className="sr-only">Navigation</DialogTitle>
          <DialogDescription className="sr-only">
            Site navigation menu
          </DialogDescription>
          <div className="flex h-full">
            <Sidebar />
          </div>
        </DialogContent>
      </Dialog>

      <CommandPalette />
    </div>
  );
}
