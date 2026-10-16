import type { Metadata } from "next";

// Buyer links are unlisted: keep them out of search engines. The page sets its own title from the property.
export const metadata: Metadata = {
  title: "Property in 3D · ARCHFLOW",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function ShareLayout({ children }: LayoutProps<"/share/[token]">) {
  return children;
}
