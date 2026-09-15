/**
 * One-off backfill: wrap each existing Workspace in its own Organization and
 * link the workspace's user (if any) to that organization.
 *
 * Safe to re-run: it skips workspaces that already have an organizationId.
 *
 * Run with:  npm run orgs:migrate
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function slugify(input) {
  const base = (input || "org")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "org";
}

async function uniqueSlug(base) {
  let slug = base;
  let n = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await prisma.organization.findUnique({ where: { slug } })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

async function main() {
  const workspaces = await prisma.workspace.findMany({
    where: { organizationId: null },
    include: { user: true },
  });

  if (workspaces.length === 0) {
    console.log("No workspaces to migrate. All set.");
    return;
  }

  console.log(`Migrating ${workspaces.length} workspace(s) into organizations...`);

  for (const ws of workspaces) {
    const ownerName = ws.user?.name || ws.user?.email || ws.name || "Organization";
    const orgName = ws.user ? `${ownerName}'s Organization` : ws.name || "Organization";
    const slug = await uniqueSlug(slugify(orgName));

    const org = await prisma.organization.create({
      data: { name: orgName, slug },
    });

    await prisma.workspace.update({
      where: { id: ws.id },
      data: { organizationId: org.id },
    });

    if (ws.userId) {
      await prisma.user.update({
        where: { id: ws.userId },
        data: { organizationId: org.id },
      });
    }

    console.log(
      `  ✓ ${orgName} (slug=${slug}) ← workspace ${ws.id}${ws.userId ? ` / user ${ws.user?.email}` : " (orphan)"}`
    );
  }

  console.log("Migration complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
