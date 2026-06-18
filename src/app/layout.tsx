import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Sitecore Marketplace Extensions',
  description: 'Sitecore Marketplace extension starter application',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
