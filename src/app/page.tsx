import { redirect } from "next/navigation";

// The marketing site lives in the pmos-website repo (pm-os.io).
// The app root just sends visitors to login; the middleware forwards
// authenticated users to /dashboard.
export default function RootPage() {
  redirect("/login");
}
