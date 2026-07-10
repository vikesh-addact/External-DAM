import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Content Bridge - Sitecore Marketplace',
  description: 'Content promotion and transfer tool for Sitecore XM Cloud environments',
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
