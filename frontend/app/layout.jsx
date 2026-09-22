import "./globals.css";

export const metadata = {
  title: "DiskLens",
  description: "Local device storage explorer",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
