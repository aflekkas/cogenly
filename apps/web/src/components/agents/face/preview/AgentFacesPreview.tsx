import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";

import { AGENT_FACE_STATES, AgentFace, agentAppearance, type AgentFaceState } from "..";

const AGENTS = [
  "Atlas",
  "Juniper",
  "Orion",
  "Pixel",
  "Saffron",
  "Tidewater",
  "Quill",
  "Nova",
  "Bramble",
  "Cobalt",
  "Echo",
  "Marlow",
];

const STATE_LABELS: Record<AgentFaceState, string> = {
  idle: "Idle",
  thinking: "Thinking",
  working: "Working",
  needsYou: "Needs you",
  blocked: "Blocked",
  done: "Done",
  asleep: "Asleep",
  created: "Created",
};

const LAYERED_STATES: ReadonlyArray<AgentFaceState> = ["thinking", "blocked", "asleep"];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-medium text-muted-foreground text-sm">{title}</h2>
      {children}
    </section>
  );
}

function SidebarRow({ name, state, size }: { name: string; state: AgentFaceState; size: number }) {
  // `created` settles by itself; the label follows it there through `onSettled`.
  const [shown, setShown] = useState(state);
  return (
    <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm">
      <AgentFace
        seed={name.toLowerCase()}
        state={state}
        size={size}
        onSettled={() => setShown("idle")}
      />
      <span className="flex-1 truncate">{name}</span>
      <span className="text-muted-foreground text-xs">{STATE_LABELS[shown]}</span>
    </div>
  );
}

function SidebarRows({ size, replay }: { size: number; replay: number }) {
  return (
    <div className="flex w-64 flex-col rounded-lg border bg-card p-1" data-sidebar={size}>
      {AGENT_FACE_STATES.map((state, index) => (
        <SidebarRow
          key={state === "created" ? `${state}-${replay}` : state}
          name={AGENTS[index]!}
          state={state}
          size={size}
        />
      ))}
    </div>
  );
}

function useFps() {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let frames = 0;
    let since = performance.now();
    let handle = requestAnimationFrame(function count(now) {
      frames++;
      if (now - since >= 1000) {
        setFps(Math.round((frames * 1000) / (now - since)));
        frames = 0;
        since = now;
      }
      handle = requestAnimationFrame(count);
    });
    return () => cancelAnimationFrame(handle);
  }, []);
  return fps;
}

function FpsMeter() {
  const fps = useFps();
  return (
    <div
      data-fps={fps}
      className="fixed right-4 bottom-3 font-mono text-muted-foreground text-xs tabular-nums"
    >
      {fps} fps
    </div>
  );
}

export function AgentFacesPreview() {
  const [gridState, setGridState] = useState<AgentFaceState>("idle");
  const [replay, setReplay] = useState(0);
  return (
    <main className="flex min-h-screen flex-col gap-10 bg-background p-10 text-foreground">
      <div className="flex items-center gap-4">
        <h1 className="font-semibold text-lg">Agent faces</h1>
        <Button size="sm" variant="outline" onClick={() => setReplay((count) => count + 1)}>
          Replay created
        </Button>
      </div>

      <Section title="Layered vs full-body">
        <div className="flex flex-wrap gap-12" data-section="layered">
          {LAYERED_STATES.map((state) => (
            <div key={state} className="flex flex-col items-center gap-3">
              <div className="flex items-end gap-8 pt-6 pr-6">
                {[true, false].map((layered) => (
                  <div key={String(layered)} className="flex flex-col items-center gap-2">
                    <div className="flex items-end gap-5">
                      <AgentFace seed="juniper" state={state} layered={layered} size={96} />
                      <AgentFace seed="juniper" state={state} layered={layered} size={32} />
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {layered ? "layered" : "full-body"}
                    </div>
                  </div>
                ))}
              </div>
              <div className="text-sm">{STATE_LABELS[state]}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Sidebar sizes (28px, 32px)">
        <div className="flex flex-wrap gap-6">
          <SidebarRows size={28} replay={replay} />
          <SidebarRows size={32} replay={replay} />
        </div>
      </Section>

      <Section title="States">
        <div className="flex flex-wrap gap-10 pt-4" data-section="states">
          {AGENT_FACE_STATES.map((state) => (
            <div key={state} className="flex flex-col items-center gap-2">
              <AgentFace
                key={state === "created" ? `${state}-${replay}` : state}
                seed="orion"
                state={state}
                size={96}
              />
              <div className="text-muted-foreground text-xs">{STATE_LABELS[state]}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Seeded agents (36 live faces)">
        <div className="flex flex-wrap gap-1.5">
          {AGENT_FACE_STATES.map((state) => (
            <Button
              key={state}
              size="sm"
              variant={state === gridState ? "default" : "outline"}
              onClick={() => setGridState(state)}
            >
              {STATE_LABELS[state]}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-6 gap-x-6 gap-y-8 pt-4" data-section="grid">
          {Array.from({ length: 36 }, (_, index) => {
            const base = AGENTS[index % AGENTS.length]!;
            const name = index < AGENTS.length ? base : `${base} ${Math.floor(index / 12) + 1}`;
            const seed = name.toLowerCase();
            const look = agentAppearance(seed);
            return (
              <div key={name} className="flex flex-col items-center gap-2">
                <AgentFace
                  key={gridState === "created" ? `${seed}-${replay}` : seed}
                  seed={seed}
                  state={gridState}
                  size={72}
                />
                <div className="text-sm">{name}</div>
                <div className="text-muted-foreground text-xs">
                  {look.shape} · {look.color} · {look.expression}
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      <FpsMeter />
    </main>
  );
}
