import Image from "next/image";

/**
 * The official ARCHFLOW logo, shown directly on the header background (no plate, by the user's choice).
 *
 * Asset: /archflow-logo-trimmed.png is the original /archflow-logo.png.png with only its fully transparent
 * border removed (1115×226, every remaining pixel identical; the original file is untouched). Served
 * unoptimized so it is never re-encoded, scaled by height with width auto (aspect ratio kept, object-fit: contain).
 * Height 24px on phones (~118px wide), 32px from sm up (~158px wide).
 */
export default function Logo() {
  return (
    <span className="inline-flex shrink-0 items-center justify-center">
      <Image
        src="/archflow-logo-trimmed.png"
        alt="ARCHFLOW"
        width={1115}
        height={226}
        unoptimized
        preload
        draggable={false}
        className="block h-6 w-auto max-w-none select-none object-contain sm:h-8"
      />
    </span>
  );
}
