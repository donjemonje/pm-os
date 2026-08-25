const PRINT_STYLES = `
  @page { margin: 18mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0;
    color: #0c1929;
    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    line-height: 1.6;
  }
  .markdown-body h1, .um-doc h1 { font-size: 1.75rem; font-weight: 700; margin: 0 0 1.25em; padding-bottom: 0.75rem; border-bottom: 3px solid #7aa7ff; }
  .markdown-body h2, .um-doc h2 { font-size: 1.25rem; font-weight: 600; margin: 1.25em 0 0.5em; }
  .markdown-body h3, .um-doc h3 { font-size: 1.1rem; font-weight: 600; margin: 1em 0 0.5em; }
  .markdown-body p, .markdown-body ul, .markdown-body ol,
  .um-doc p, .um-doc ul, .um-doc ol { margin: 0 0 0.75em; }
  .markdown-body ul, .markdown-body ol, .um-doc ul, .um-doc ol { padding-left: 1.25em; }
  .markdown-body code, .um-doc code {
    background: #e8f2fc;
    color: #7aa7ff;
    padding: 0.1em 0.35em;
    border-radius: 4px;
    font-size: 0.875em;
  }
  .markdown-body pre, .um-doc pre {
    background: #0f172a;
    color: #e2e8f0;
    padding: 1em;
    border-radius: 8px;
    overflow-x: auto;
    margin-bottom: 1em;
  }
  .markdown-body pre code, .um-doc pre code { background: transparent; padding: 0; color: inherit; }
  .markdown-body blockquote, .um-doc blockquote {
    border-left: 3px solid #7aa7ff;
    padding-left: 1em;
    color: #4a4068;
    margin: 0 0 1em;
  }
  .um-doc img, .um-image { max-width: 100%; height: auto; border-radius: 8px; }
  .um-image-wrap { display: block; margin: 1rem 0; }
  a { color: #1a4a8a; }
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function prepareExportHtml(contentRoot: HTMLElement): string {
  const clone = contentRoot.cloneNode(true) as HTMLElement;

  clone.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src");
    if (src && !src.startsWith("http://") && !src.startsWith("https://") && !src.startsWith("data:")) {
      img.setAttribute("src", new URL(src, window.location.origin).href);
    }
  });

  return clone.innerHTML;
}

function waitForImages(doc: Document): Promise<void> {
  const images = Array.from(doc.querySelectorAll("img"));
  if (images.length === 0) return Promise.resolve();

  return Promise.all(
    images.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete) {
            resolve();
            return;
          }
          img.onload = () => resolve();
          img.onerror = () => resolve();
        })
    )
  ).then(() => undefined);
}

export function exportDocumentAsPdf(contentRoot: HTMLElement, title: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText =
      "position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none";
    document.body.appendChild(iframe);

    const win = iframe.contentWindow;
    const doc = iframe.contentDocument ?? win?.document;
    if (!win || !doc) {
      iframe.remove();
      reject(new Error("Could not prepare the document for export."));
      return;
    }

    const safeTitle = escapeHtml(title || "Document");
    const bodyHtml = prepareExportHtml(contentRoot);

    doc.open();
    doc.write(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${safeTitle}</title>
  <style>${PRINT_STYLES}</style>
</head>
<body>
  ${bodyHtml}
</body>
</html>`);
    doc.close();

    void waitForImages(doc)
      .then(() => {
        win.focus();
        win.print();

        // Stop loading UI once the print dialog opens — don't wait for afterprint.
        resolve();

        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          iframe.remove();
        };

        win.addEventListener("afterprint", cleanup, { once: true });
        window.addEventListener("afterprint", cleanup, { once: true });

        const printMedia = window.matchMedia("print");
        const onPrintChange = (event: MediaQueryListEvent) => {
          if (!event.matches) {
            printMedia.removeEventListener("change", onPrintChange);
            cleanup();
          }
        };
        printMedia.addEventListener("change", onPrintChange);

        window.setTimeout(cleanup, 3000);
      })
      .catch(reject);
  });
}
