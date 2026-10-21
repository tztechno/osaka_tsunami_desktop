import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromFile } from 'geotiff';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(appRoot, '..');

const japanTifPath = path.join(workspaceRoot, 'japan.tif');
const osakaTifPath = path.resolve(workspaceRoot, '..', 'N60_osaka_viewer', 'docs', 'osaka.tif');

async function inspect(filePath, label) {
  console.log(`=== ${label} (${filePath}) ===`);
  try {
    const tiff = await fromFile(filePath);
    const image = await tiff.getImage();
    const width = image.getWidth();
    const height = image.getHeight();
    const bbox = image.getBoundingBox();
    const [ox, oy] = image.getOrigin();
    const [rx, ry] = image.getResolution();
    const samplesPerPixel = image.getSamplesPerPixel();
    const sampleFormat = image.getSampleFormat();
    const bitsPerSample = image.getBitsPerSample();

    console.log(`Dimensions: ${width} x ${height}`);
    console.log(`BBox: [${bbox.map(v => v.toFixed(6)).join(', ')}]`);
    console.log(`Origin: [${ox.toFixed(6)}, ${oy.toFixed(6)}]`);
    console.log(`Resolution: [${rx.toFixed(8)}, ${ry.toFixed(8)}]`);
    console.log(`Samples: ${samplesPerPixel}, Format: ${sampleFormat}, Bits: ${bitsPerSample}`);

    // Read sample near center to check value range
    const cx = Math.floor(width / 2);
    const cy = Math.floor(height / 2);
    const window = [cx - 2, cy - 2, cx + 2, cy + 2];
    const raster = await image.readRasters({ window });
    console.log(`Sample values around center (${cx}, ${cy}):`, Array.from(raster[0].slice(0, 5)));
  } catch (err) {
    console.error(`Error inspecting ${label}:`, err.message);
  }
}

async function run() {
  await inspect(japanTifPath, 'japan.tif');
  await inspect(osakaTifPath, 'docs/osaka.tif');
}

run();
