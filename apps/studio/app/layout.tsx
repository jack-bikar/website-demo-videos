import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Demo Video Studio',
  description: 'Turn websites into polished product-demo videos',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="topbar">
          <Link href="/" className="brand">
            ▸ Demo Video <span>Studio</span>
          </Link>
        </div>
        {children}
      </body>
    </html>
  );
}
