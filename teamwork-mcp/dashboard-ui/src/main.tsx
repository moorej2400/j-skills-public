import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { AppRoutes } from "./routes";
import "./index.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element");

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <BrowserRouter>
      <TooltipProvider delayDuration={150}>
        <AppRoutes />
        <Toaster />
      </TooltipProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
