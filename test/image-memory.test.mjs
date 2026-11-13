import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageMemoryService } from '../dist/image-memory.js';
import { WorkspaceContextService } from '../dist/workspace-memory.js';

const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlS/qQAAAAASUVORK5CYII=',
  'base64',
);

function fakeProjects(root) {
  return {
    status(input) {
      if (input !== root) throw new Error('Project has not been initialized.');
      return { projectId:'project-image', name:'Image Memory Project', root, type:'software', stateDir:root + '.nhd', updatedAt:'2026-09-29T00:00:00.000Z', documents:0, decisions:[], unresolved:0, currentEdit:null, lastQa:null };
    },
    readMemory(input) {
      if (input !== root) throw new Error('Project has not been initialized.');
      return { section:'memory', text:'# Legacy memory' };
    },
    listDecisions() { return []; },
    syncWorkspaceCheckpoint() { return { synced:true }; },
  };
}

test('image memory stores binary assets by SHA-256 and deduplicates the payload', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nhd-image-memory-'));
  const root = join(dataDir, 'project');
  const imagePath = join(dataDir, 'diagram.png');
  await writeFile(imagePath, onePixelPng);

  const first = new ImageMemoryService({ dataDir });
  const inspection = first.inspectFile(imagePath);
  assert.equal(inspection.mimeType, 'image/png');
  assert.equal(inspection.width, 1);
  assert.equal(inspection.height, 1);

  const storedA = first.storeFile(root, imagePath, {
    caption:'Memory architecture diagram',
    tags:['memory','architecture'],
    taskId:'task-1',
    chatId:'chat-1',
  }, inspection.sha256);
  const storedB = first.storeFile(root, imagePath, {
    caption:'Same binary, second project reference',
    tags:['memory','reference'],
    taskId:'task-2',
    chatId:'chat-2',
  }, inspection.sha256);

  assert.notEqual(storedA.id, storedB.id);
  assert.equal(storedA.sha256, storedB.sha256);
  assert.equal(first.stats(root).images, 2);
  assert.equal(first.stats(root).assets, 1);

  const search = first.search(root, 'architecture memory', 10);
  assert.equal(search.results[0].id, storedA.id);
  first.close();

  const second = new ImageMemoryService({ dataDir });
  const restored = second.read(root, storedA.id);
  assert.equal(restored.image.mimeType, 'image/png');
  assert.equal(Buffer.from(restored.image.data, 'base64').equals(onePixelPng), true);
  assert.equal(second.stats(root).assets, 1);
  second.close();
});

test('workspace context bootstrap and recall include durable image memory', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nhd-workspace-image-memory-'));
  const root = join(dataDir, 'project');
  const imagePath = join(dataDir, 'dashboard.png');
  await writeFile(imagePath, onePixelPng);

  const service = new WorkspaceContextService({ dataDir }, fakeProjects(root));
  service.checkpoint(root, { summary:'Image-memory feature work.', objective:'Persist visual context across chats.' });
  const preview = service.inspectImageSource(root, imagePath);
  const stored = service.storeImageFile(root, imagePath, {
    caption:'Dashboard showing MCP visual memory',
    ocrText:'Image Memory project dashboard',
    tags:['dashboard','visual-memory','mcp'],
    taskId:'task-image',
    chatId:'chat-image',
  }, preview.sha256);

  const bootstrap = service.bootstrap(root, { activate:false });
  assert.ok(bootstrap.recentImages.some((item) => item.id === stored.id));
  assert.equal(bootstrap.recentEvents.some((event) => event.eventType === 'memory.image'), true);
  assert.equal(service.stats().images, 1);
  assert.equal(service.stats().imageAssets, 1);

  const recall = service.recall(root, 'dashboard visual memory', 10);
  const recalledImage = recall.results.find((item) => item.kind === 'image');
  assert.equal(recalledImage.id, stored.id);
  assert.equal(recalledImage.metadata.mimeType, 'image/png');

  const readBack = service.readImage(root, stored.id);
  assert.equal(Buffer.from(readBack.image.data, 'base64').equals(onePixelPng), true);
  service.close();
});
