import { useState } from "react";
import { Sidebar, type NavKey } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { Overview } from "./pages/Overview";
import { Decisions } from "./pages/Decisions";
import { Indicators } from "./pages/Indicators";
import { Schedule } from "./pages/Schedule";
import { Pnl } from "./pages/Pnl";
import { useDecisions } from "./lib/queries";

const PAGES: Record<NavKey, () => JSX.Element> = {
  overview: Overview,
  decisions: Decisions,
  indicators: Indicators,
  schedule: Schedule,
  pnl: Pnl,
};

export function App() {
  const [active, setActive] = useState<NavKey>("overview");
  const { data: decisionsPage } = useDecisions(50);
  const Page = PAGES[active];
  return (
    <div className="app">
      <Sidebar
        active={active}
        onNav={setActive}
        decisionsCount={decisionsPage?.rows.length}
      />
      <Topbar />
      <main className="main">
        <Page />
      </main>
    </div>
  );
}
