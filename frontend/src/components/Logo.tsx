/** ARCHFLOW mark (a plan corner: walls, a door swing, one interior wall) and serif wordmark. */
export default function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5 text-foreground">
      <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden className="shrink-0">
        <rect x="1" y="1" width="24" height="24" rx="5" fill="var(--accent)" />
        <path d="M11 6.5H6.5v13h13v-13H15" stroke="var(--on-accent)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M15 6.5a4 4 0 0 1-4 4" stroke="var(--sage)" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M13 12.5v7" stroke="var(--on-accent)" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      {!compact && <span className="font-display text-[1.35rem] font-medium leading-none tracking-[-0.01em]">Archflow</span>}
    </span>
  );
}
