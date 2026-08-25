import { db } from "./db";
import {
  getGoogleDriveClientCredentials,
  GOOGLE_DOC_MIME,
  GOOGLE_FOLDER_MIME,
  GOOGLE_SLIDES_MIME,
} from "./google-drive-oauth-config";
import { exportDriveFileAsText } from "./google-drive-content";
import type {
  GoogleDriveFile,
  GoogleDriveFileContent,
  GoogleDriveFileKind,
  GoogleDriveBrowseItem,
  GoogleDriveBrowseResult,
  GoogleDriveFolderOption,
} from "./types";
import { parseJsonArray } from "./utils";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";

const SHARED_DRIVE_QUERY = {
  supportsAllDrives: "true",
  includeItemsFromAllDrives: "true",
  corpora: "allDrives",
} as const;

function appendSharedDriveParams(params: URLSearchParams) {
  params.set("supportsAllDrives", SHARED_DRIVE_QUERY.supportsAllDrives);
  params.set("includeItemsFromAllDrives", SHARED_DRIVE_QUERY.includeItemsFromAllDrives);
  params.set("corpora", SHARED_DRIVE_QUERY.corpora);
}

async function listSharedDrives(workspaceId: string): Promise<Map<string, string>> {
  const drives = new Map<string, string>();
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      pageSize: "100",
      fields: "nextPageToken,drives(id,name)",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const response = await driveFetch(workspaceId, `/drives?${params.toString()}`);
    const data = (await response.json()) as {
      nextPageToken?: string;
      drives?: Array<{ id: string; name: string }>;
    };

    for (const drive of data.drives ?? []) {
      drives.set(drive.id, drive.name);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return drives;
}

async function getValidConnection(workspaceId: string) {
  const connection = await db.googleDriveConnection.findUnique({ where: { workspaceId } });
  if (!connection) return null;

  if (connection.expiresAt.getTime() > Date.now() + 60_000) {
    return connection;
  }

  const creds = getGoogleDriveClientCredentials();
  if (!creds) return null;

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: "refresh_token",
      refresh_token: connection.refreshToken,
    }),
  });

  if (!response.ok) {
    await db.googleDriveConnection.deleteMany({ where: { workspaceId } });
    return null;
  }

  const tokens = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return db.googleDriveConnection.update({
    where: { workspaceId },
    data: {
      accessToken: tokens.access_token,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    },
  });
}

async function driveFetch(workspaceId: string, path: string, init?: RequestInit) {
  const connection = await getValidConnection(workspaceId);
  if (!connection) throw new Error("Google Drive not connected");

  const response = await fetch(`${DRIVE_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Google Drive API error: ${await response.text()}`);
  }

  return response;
}

function fileKind(mimeType: string): GoogleDriveFileKind {
  if (mimeType === GOOGLE_DOC_MIME) return "document";
  if (mimeType === GOOGLE_SLIDES_MIME) return "presentation";
  return "other";
}

export async function fetchGoogleAccountEmail(accessToken: string): Promise<string | null> {
  const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { email?: string };
  return data.email ?? null;
}

export async function getGoogleDriveConnectionStatus(workspaceId: string) {
  const connection = await db.googleDriveConnection.findUnique({ where: { workspaceId } });
  if (!connection) return null;

  return {
    connected: true,
    email: connection.email,
    folderIds: parseJsonArray(connection.folderIds),
  };
}

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function driveListChildren(
  workspaceId: string,
  query: string,
  pageSize = "100"
): Promise<Array<{ id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string }>> {
  const items: Array<{
    id: string;
    name: string;
    mimeType: string;
    modifiedTime?: string;
    webViewLink?: string;
  }> = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: query,
      pageSize,
      orderBy: "folder,name",
      fields: "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)",
    });
    appendSharedDriveParams(params);
    if (pageToken) params.set("pageToken", pageToken);

    const response = await driveFetch(workspaceId, `/files?${params.toString()}`);
    const data = (await response.json()) as {
      nextPageToken?: string;
      files?: Array<{
        id: string;
        name: string;
        mimeType: string;
        modifiedTime?: string;
        webViewLink?: string;
      }>;
    };
    items.push(...(data.files ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return items;
}

function toBrowseFolder(item: { id: string; name: string; modifiedTime?: string }, type: GoogleDriveBrowseItem["type"] = "folder"): GoogleDriveBrowseItem {
  return { id: item.id, name: item.name, type, modifiedTime: item.modifiedTime };
}

function toBrowseFile(item: {
  id: string;
  name: string;
  modifiedTime?: string;
  webViewLink?: string;
}): GoogleDriveBrowseItem {
  return {
    id: item.id,
    name: item.name,
    type: "file",
    modifiedTime: item.modifiedTime,
    webViewLink: item.webViewLink,
  };
}

export async function browseGoogleDrive(
  workspaceId: string,
  options?: { parentId?: string; search?: string }
): Promise<GoogleDriveBrowseResult> {
  const connection = await getValidConnection(workspaceId);
  if (!connection) {
    return { parentId: "root", folders: [], files: [] };
  }

  const parentId = options?.parentId?.trim() || "root";
  const search = options?.search?.trim();

  if (search) {
    const contains = `name contains '${escapeDriveQuery(search)}'`;
    const [folderItems, fileItems] = await Promise.all([
      driveListChildren(
        workspaceId,
        `mimeType='${GOOGLE_FOLDER_MIME}' and trashed=false and ${contains}`,
        "50"
      ),
      driveListChildren(
        workspaceId,
        `mimeType='${GOOGLE_DOC_MIME}' and trashed=false and ${contains}`,
        "50"
      ),
    ]);

    return {
      parentId: "search",
      folders: folderItems.map((item) => toBrowseFolder(item)),
      files: fileItems.map(toBrowseFile),
    };
  }

  if (parentId === "root") {
    const sharedDrives = await listSharedDrives(workspaceId);
    const folders: GoogleDriveBrowseItem[] = [
      { id: "my-drive", name: "My Drive", type: "my_drive" },
      ...Array.from(sharedDrives.entries()).map(([id, name]) => ({
        id,
        name,
        type: "shared_drive" as const,
      })),
    ];
    return { parentId: "root", folders, files: [] };
  }

  const driveParent = parentId === "my-drive" ? "root" : parentId;
  const children = await driveListChildren(
    workspaceId,
    `'${escapeDriveQuery(driveParent)}' in parents and trashed=false`
  );

  const folders: GoogleDriveBrowseItem[] = [];
  const files: GoogleDriveBrowseItem[] = [];

  for (const item of children) {
    if (item.mimeType === GOOGLE_FOLDER_MIME) {
      folders.push(toBrowseFolder(item));
    } else if (item.mimeType === GOOGLE_DOC_MIME) {
      files.push(toBrowseFile(item));
    }
  }

  return { parentId, folders, files };
}

export async function listGoogleDriveFolderOptions(
  workspaceId: string
): Promise<GoogleDriveFolderOption[]> {
  const connection = await getValidConnection(workspaceId);
  if (!connection) return [];

  const sharedDrives = await listSharedDrives(workspaceId);
  const folders: Array<{ id: string; name: string; parents?: string[]; driveId?: string }> = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: `mimeType='${GOOGLE_FOLDER_MIME}' and trashed=false`,
      pageSize: "1000",
      orderBy: "name",
      fields: "nextPageToken,files(id,name,parents,driveId)",
    });
    appendSharedDriveParams(params);
    if (pageToken) params.set("pageToken", pageToken);

    const response = await driveFetch(workspaceId, `/files?${params.toString()}`);
    const data = (await response.json()) as {
      nextPageToken?: string;
      files?: Array<{ id: string; name: string; parents?: string[]; driveId?: string }>;
    };
    folders.push(...(data.files ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  const byId = new Map(folders.map((folder) => [folder.id, folder]));

  function folderPath(id: string, visited = new Set<string>()): { relativePath: string; prefix: string } {
    if (visited.has(id)) return { relativePath: "…", prefix: "My Drive" };
    visited.add(id);
    const folder = byId.get(id);
    if (!folder) return { relativePath: "", prefix: "My Drive" };

    const parentId = folder.parents?.[0];
    if (!parentId || parentId === "root") {
      return { relativePath: folder.name, prefix: "My Drive" };
    }
    if (sharedDrives.has(parentId)) {
      return {
        relativePath: folder.name,
        prefix: `Shared: ${sharedDrives.get(parentId)}`,
      };
    }

    const parent = folderPath(parentId, visited);
    return {
      relativePath: parent.relativePath
        ? `${parent.relativePath} / ${folder.name}`
        : folder.name,
      prefix: parent.prefix,
    };
  }

  const options: GoogleDriveFolderOption[] = [];

  for (const [driveId, driveName] of sharedDrives) {
    options.push({
      id: driveId,
      name: driveName,
      path: `Shared: ${driveName}`,
      depth: 1,
    });
  }

  for (const folder of folders) {
    const { relativePath, prefix } = folderPath(folder.id);
    const path = `${prefix} / ${relativePath}`;
    options.push({
      id: folder.id,
      name: folder.name,
      path,
      depth: path.split(" / ").length - 1,
    });
  }

  return options.sort((a, b) => a.path.localeCompare(b.path));
}

export async function listGoogleDriveFiles(
  workspaceId: string,
  options?: { search?: string; folderId?: string }
): Promise<GoogleDriveFile[]> {
  const connection = await getValidConnection(workspaceId);
  if (!connection) return [];

  const savedFolderIds = parseJsonArray(connection.folderIds);
  const search = options?.search?.trim();
  const folderId = options?.folderId?.trim();

  const searchFilter = search
    ? ` and name contains '${search.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
    : "";

  let parentFilter = "";
  if (folderId) {
    parentFilter = ` and '${folderId.replace(/'/g, "\\'")}' in parents`;
  } else if (savedFolderIds.length > 0) {
    parentFilter = ` and (${savedFolderIds.map((id) => `'${id}' in parents`).join(" or ")})`;
  }

  const mimeFilter = `mimeType='${GOOGLE_DOC_MIME}' and trashed=false${searchFilter}${parentFilter}`;
  const q = mimeFilter;

  const params = new URLSearchParams({
    q,
    pageSize: search ? "25" : "50",
    orderBy: "modifiedTime desc",
    fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
  });
  appendSharedDriveParams(params);

  const response = await driveFetch(workspaceId, `/files?${params.toString()}`);
  const data = (await response.json()) as {
    files?: Array<{
      id: string;
      name: string;
      mimeType: string;
      modifiedTime?: string;
      webViewLink?: string;
    }>;
  };

  return (data.files ?? []).map((file) => ({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    kind: fileKind(file.mimeType),
    modifiedTime: file.modifiedTime,
    webViewLink: file.webViewLink,
  }));
}

/**
 * Search inside document bodies (Google's own full-text index), scoped to the
 * workspace's saved folders when configured. Drive returns results in
 * relevance order — fullText queries do not support orderBy.
 */
export async function searchGoogleDriveFullText(
  workspaceId: string,
  query: string,
  limit = 10
): Promise<GoogleDriveFile[]> {
  const connection = await getValidConnection(workspaceId);
  if (!connection) return [];

  const escaped = escapeDriveQuery(query.trim());
  if (!escaped) return [];

  const savedFolderIds = parseJsonArray(connection.folderIds);
  const parentFilter =
    savedFolderIds.length > 0
      ? ` and (${savedFolderIds.map((id) => `'${escapeDriveQuery(id)}' in parents`).join(" or ")})`
      : "";

  const params = new URLSearchParams({
    q: `fullText contains '${escaped}' and mimeType='${GOOGLE_DOC_MIME}' and trashed=false${parentFilter}`,
    pageSize: String(limit),
    fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
  });
  appendSharedDriveParams(params);

  const response = await driveFetch(workspaceId, `/files?${params.toString()}`);
  const data = (await response.json()) as {
    files?: Array<{
      id: string;
      name: string;
      mimeType: string;
      modifiedTime?: string;
      webViewLink?: string;
    }>;
  };

  return (data.files ?? []).slice(0, limit).map((file) => ({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    kind: fileKind(file.mimeType),
    modifiedTime: file.modifiedTime,
    webViewLink: file.webViewLink,
  }));
}

export async function fetchGoogleDriveFileContents(
  workspaceId: string,
  fileIds: string[]
): Promise<GoogleDriveFileContent[]> {
  const connection = await getValidConnection(workspaceId);
  if (!connection) throw new Error("Google Drive not connected");

  const uniqueIds = [...new Set(fileIds)];
  const results: GoogleDriveFileContent[] = [];

  for (const fileId of uniqueIds) {
    const metaRes = await driveFetch(
      workspaceId,
      `/files/${fileId}?fields=id,name,mimeType,webViewLink&supportsAllDrives=true`
    );
    const meta = (await metaRes.json()) as {
      id: string;
      name: string;
      mimeType: string;
      webViewLink?: string;
    };

    const kind = fileKind(meta.mimeType);
    const text = await exportDriveFileAsText(connection.accessToken, fileId, meta.mimeType);

    results.push({
      id: meta.id,
      name: meta.name,
      kind,
      text,
      webViewLink: meta.webViewLink,
    });
  }

  return results;
}

export async function disconnectGoogleDrive(workspaceId: string) {
  await db.googleDriveConnection.deleteMany({ where: { workspaceId } });
}

export async function saveGoogleDriveFolderIds(workspaceId: string, folderIds: string[]) {
  await db.googleDriveConnection.update({
    where: { workspaceId },
    data: { folderIds: JSON.stringify(folderIds) },
  });
}

export function buildDriveContext(files: GoogleDriveFileContent[]): string {
  return files
    .map((file) => {
      const label = file.kind === "presentation" ? "Google Slides" : "Google Doc";
      return `[Drive: ${file.name}] (${label})
${file.text.slice(0, 4000)}`;
    })
    .join("\n\n---\n\n");
}
