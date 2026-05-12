const PAGE_SIZES = {
  a4: { width: 8.27, height: 11.69 },
  letter: { width: 8.5, height: 11 },
};

const DPI = 150;
const PDF_POINTS_PER_INCH = 72;

const form = document.querySelector("#converter-form");
const dropZone = document.querySelector("#drop-zone");
const fileInput = document.querySelector("#file-input");
const fileMeta = document.querySelector("#file-meta");
const convertButton = document.querySelector("#convert-button");
const statusLine = document.querySelector("#status-line");
const pageCount = document.querySelector("#page-count");
const pageStack = document.querySelector("#page-stack");

let selectedFile = null;
let loadedImage = null;

fileInput.addEventListener("change", async () => {
  await setFile(fileInput.files?.[0]);
});

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  });
}

dropZone.addEventListener("drop", async (event) => {
  await setFile(event.dataTransfer?.files?.[0]);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedFile || !loadedImage) return;

  convertButton.disabled = true;
  setStatus("Generation du PDF...");

  try {
    const options = readOptions();
    const result = await buildPdf(loadedImage, selectedFile.name, options);
    downloadBlob(result.blob, result.fileName);
    renderPreview(result.previewUrls, result.pageTotal);
    setStatus(`${result.pageTotal} page${result.pageTotal > 1 ? "s" : ""} generee${result.pageTotal > 1 ? "s" : ""}.`);
  } catch (error) {
    console.error(error);
    setStatus("Impossible de generer le PDF avec cette image.");
  } finally {
    convertButton.disabled = false;
  }
});

for (const controlId of ["page-size", "margin", "overlap"]) {
  document.querySelector(`#${controlId}`).addEventListener("input", () => {
    if (!loadedImage) return;
    pageCount.textContent = formatPageCount(estimatePageCount(loadedImage, readOptions()));
  });
}

async function setFile(file) {
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    setStatus("Choisis un fichier image.");
    return;
  }

  selectedFile = file;
  setStatus("Chargement de l'image...");
  loadedImage = await loadImage(file);

  const dimensions = `${loadedImage.naturalWidth} x ${loadedImage.naturalHeight}px`;
  const size = formatBytes(file.size);
  fileMeta.textContent = `${file.name} - ${dimensions} - ${size}`;
  convertButton.disabled = false;
  const estimatedPages = estimatePageCount(loadedImage, readOptions());
  pageCount.textContent = formatPageCount(estimatedPages);
  setStatus("Pret.");
  renderImagePreview(loadedImage);
}

function readOptions() {
  const pageSize = document.querySelector("#page-size").value;
  const margin = Number(document.querySelector("#margin").value);
  const quality = Number(document.querySelector("#quality").value);
  const overlap = Number(document.querySelector("#overlap").value);
  return {
    pageSize,
    margin: Number.isFinite(margin) ? Math.max(0, margin) : 0.35,
    quality: Number.isFinite(quality) ? quality : 0.85,
    overlap: Number.isFinite(overlap) ? Math.max(0, overlap) : 0,
  };
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = URL.createObjectURL(file);
  });
}

function estimatePageCount(image, options) {
  const metrics = getPageMetrics(image, options);
  return Math.max(1, Math.ceil(image.naturalHeight / metrics.sliceHeight));
}

async function buildPdf(image, originalName, options) {
  const metrics = getPageMetrics(image, options);
  const quietScores = getQuietRowScores(image);
  const ranges = getSplitRanges(image.naturalHeight, metrics.sliceHeight, quietScores, options.overlap);
  const pageImages = [];
  const previewUrls = [];

  for (let index = 0; index < ranges.length; index += 1) {
    setStatus(`Preparation de la page ${index + 1}/${ranges.length}...`);
    await nextFrame();
    const pageImage = await renderPdfPage(image, ranges[index], metrics, options.quality);
    pageImages.push(pageImage);
    if (previewUrls.length < 6) previewUrls.push(URL.createObjectURL(pageImage.blob));
  }

  const pdfBytes = buildPdfBytes(pageImages, metrics);
  const blob = new Blob([pdfBytes], { type: "application/pdf" });
  return {
    blob,
    fileName: `${withoutExtension(originalName)}-lisible.pdf`,
    pageTotal: ranges.length,
    previewUrls,
  };
}

function getPageMetrics(image, options) {
  const size = PAGE_SIZES[options.pageSize];
  const pageWidthPx = Math.round(size.width * DPI);
  const pageHeightPx = Math.round(size.height * DPI);
  const marginPx = Math.round(options.margin * DPI);
  const contentWidthPx = pageWidthPx - marginPx * 2;
  const contentHeightPx = pageHeightPx - marginPx * 2;
  const scale = contentWidthPx / image.naturalWidth;

  return {
    pageWidthPx,
    pageHeightPx,
    marginPx,
    contentWidthPx,
    contentHeightPx,
    sourceWidth: image.naturalWidth,
    sliceHeight: Math.max(1, Math.floor(contentHeightPx / scale)),
    pageWidthPt: size.width * PDF_POINTS_PER_INCH,
    pageHeightPt: size.height * PDF_POINTS_PER_INCH,
  };
}

function getQuietRowScores(image) {
  const sampleHeight = image.naturalHeight;
  const chunkSize = 4096;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  canvas.width = 1;
  const scores = new Array(sampleHeight);

  for (let chunkStart = 0; chunkStart < sampleHeight; chunkStart += chunkSize) {
    const chunkHeight = Math.min(chunkSize, sampleHeight - chunkStart);
    canvas.height = chunkHeight;
    context.clearRect(0, 0, 1, chunkHeight);
    context.drawImage(
      image,
      0,
      chunkStart,
      image.naturalWidth,
      chunkHeight,
      0,
      0,
      1,
      chunkHeight,
    );

    const data = context.getImageData(0, 0, 1, chunkHeight).data;
    for (let row = 0; row < chunkHeight; row += 1) {
      const offset = row * 4;
      scores[chunkStart + row] = (data[offset] + data[offset + 1] + data[offset + 2]) / 3;
    }
  }

  return scores;
}

function getSplitRanges(sourceHeight, sliceHeight, quietScores, overlap) {
  const ranges = [];
  let start = 0;
  const searchWindow = Math.round(sliceHeight * 0.18);

  while (start < sourceHeight) {
    const idealEnd = Math.min(sourceHeight, start + sliceHeight);
    if (idealEnd >= sourceHeight) {
      ranges.push({ start, end: sourceHeight });
      break;
    }

    const lower = Math.max(start + 180, idealEnd - searchWindow);
    const upper = Math.min(sourceHeight - 1, idealEnd + searchWindow);
    let bestRow = idealEnd;
    let bestValue = -Infinity;

    for (let row = lower; row <= upper; row += 1) {
      const bandStart = Math.max(0, row - 5);
      const bandEnd = Math.min(sourceHeight, row + 6);
      let total = 0;

      for (let bandRow = bandStart; bandRow < bandEnd; bandRow += 1) {
        total += quietScores[bandRow];
      }

      const whiteness = total / (bandEnd - bandStart);
      const distancePenalty = Math.abs(row - idealEnd) / Math.max(1, searchWindow);
      const value = whiteness - distancePenalty * 12;

      if (value > bestValue) {
        bestValue = value;
        bestRow = row;
      }
    }

    ranges.push({ start, end: bestRow });
    const nextStart = Math.max(0, bestRow - overlap);
    start = nextStart > start ? nextStart : bestRow;
  }

  return ranges;
}

function renderPdfPage(image, range, metrics, quality) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = metrics.pageWidthPx;
    canvas.height = metrics.pageHeightPx;
    const context = canvas.getContext("2d");

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);

    const cropHeight = range.end - range.start;
    const renderedHeight = Math.round(cropHeight * (metrics.contentWidthPx / image.naturalWidth));
    context.imageSmoothingQuality = "high";
    context.drawImage(
      image,
      0,
      range.start,
      image.naturalWidth,
      cropHeight,
      metrics.marginPx,
      metrics.marginPx,
      metrics.contentWidthPx,
      renderedHeight,
    );

    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          reject(new Error("Canvas export failed"));
          return;
        }
        resolve({
          blob,
          bytes: new Uint8Array(await blob.arrayBuffer()),
          width: canvas.width,
          height: canvas.height,
        });
      },
      "image/jpeg",
      quality,
    );
  });
}

function buildPdfBytes(pageImages, metrics) {
  const chunks = [];
  const objects = [];

  const pushText = (text) => chunks.push(new TextEncoder().encode(text));
  const pushBytes = (bytes) => chunks.push(bytes);
  const addObject = (bodyChunks) => {
    objects.push(bodyChunks);
    return objects.length;
  };

  const catalogId = 1;
  const pagesId = 2;
  const pageIds = [];

  pageImages.forEach((pageImage, index) => {
    const imageId = 3 + index * 3;
    const contentId = imageId + 1;
    const pageId = imageId + 2;
    pageIds.push(pageId);

    const xObjectName = `/Im${index + 1}`;
    const imageHeader =
      `<< /Type /XObject /Subtype /Image /Width ${pageImage.width} /Height ${pageImage.height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pageImage.bytes.length} >>\nstream\n`;
    addObject([textBytes(imageHeader), pageImage.bytes, textBytes("\nendstream")]);

    const commands = `q\n${metrics.pageWidthPt} 0 0 ${metrics.pageHeightPt} 0 0 cm\n${xObjectName} Do\nQ`;
    addObject([
      textBytes(`<< /Length ${textBytes(commands).length} >>\nstream\n${commands}\nendstream`),
    ]);

    addObject([
      textBytes(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${metrics.pageWidthPt.toFixed(2)} ${metrics.pageHeightPt.toFixed(2)}] ` +
          `/Resources << /XObject << ${xObjectName} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    ]);
  });

  objects.unshift([textBytes(`<< /Type /Pages /Kids ${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`)]);
  objects.unshift([textBytes(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)]);

  pushText("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const offsets = [0];

  objects.forEach((bodyChunks, index) => {
    offsets.push(totalLength(chunks));
    pushText(`${index + 1} 0 obj\n`);
    bodyChunks.forEach(pushBytes);
    pushText("\nendobj\n");
  });

  const xrefOffset = totalLength(chunks);
  pushText(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (let index = 1; index < offsets.length; index += 1) {
    pushText(`${String(offsets[index]).padStart(10, "0")} 00000 n \n`);
  }
  pushText(
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`,
  );

  const pdfBytes = new Uint8Array(totalLength(chunks));
  let offset = 0;
  chunks.forEach((chunk) => {
    pdfBytes.set(chunk, offset);
    offset += chunk.length;
  });
  return pdfBytes;
}

function renderImagePreview(image) {
  pageStack.innerHTML = "";
  const preview = document.createElement("div");
  preview.className = "preview-page";
  preview.style.left = "29%";
  preview.style.top = "10%";

  const img = document.createElement("img");
  img.src = image.src;
  img.alt = "";
  preview.append(img);
  pageStack.append(preview);
}

function renderPreview(urls, totalPages) {
  pageStack.innerHTML = "";
  urls.forEach((url, index) => {
    const page = document.createElement("div");
    page.className = "preview-page";
    page.style.left = `${18 + (index % 3) * 14}%`;
    page.style.top = `${8 + index * 9}%`;
    page.style.zIndex = String(index + 1);

    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    page.append(img);
    pageStack.append(page);
  });
  pageCount.textContent = formatPageCount(totalPages);
}

function downloadBlob(blob, fileName) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setStatus(message) {
  statusLine.textContent = message;
}

function textBytes(text) {
  return new TextEncoder().encode(text);
}

function totalLength(chunks) {
  return chunks.reduce((sum, chunk) => sum + chunk.length, 0);
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function withoutExtension(fileName) {
  return fileName.replace(/\.[^.]+$/, "");
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

function formatPageCount(count) {
  return `${count} page${count > 1 ? "s" : ""}`;
}
