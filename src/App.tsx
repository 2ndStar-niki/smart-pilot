import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Grid, OrbitControls, Html } from "@react-three/drei";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

type Telemetry = {
  timestamp: number;
  machine: {
    x: number;
    y: number;
    z: number;
    yawDeg: number;
  };
  joints: {
    boomDeg: number;
    armDeg: number;
    bucketDeg: number;
  };
  payloadKg: number;
  speedKph: number;
};

type ViewMode = "iso" | "top" | "side";

type TerrainPoint = {
  x: number;
  y: number;
  z: number;
};

type TerrainTriangle = {
  a: TerrainPoint;
  b: TerrainPoint;
  c: TerrainPoint;
};

type TerrainSurface = {
  id: string;
  name: string;
  sourceName: string;
  points: TerrainPoint[];
  triangles: TerrainTriangle[];
  geometry: THREE.BufferGeometry;
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  };
  pointCount: number;
  triangleCount: number;
  mode: "tin" | "pointcloud";
};

type TerrainModel = {
  sourceName: string;
  surfaces: TerrainSurface[];
};

const WS_URL = "ws://localhost:8787";

const defaultTelemetry: Telemetry = {
  timestamp: Date.now(),
  machine: { x: 0, y: 0, z: 0, yawDeg: 0 },
  joints: { boomDeg: 42, armDeg: -35, bucketDeg: 22 },
  payloadKg: 0,
  speedKph: 0
};

function degToRad(v: number) {
  return (v * Math.PI) / 180;
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function fallbackDesignHeightAt(x: number, z: number) {
  return 0.18 * Math.sin(x * 0.22) + 0.12 * Math.cos(z * 0.18) - 0.035 * z;
}

function diffColor(diff: number) {
  if (Math.abs(diff) < 0.1) return "#22c55e";
  if (diff > 0) return "#ef4444";
  return "#3b82f6";
}

function computeBounds(points: TerrainPoint[]) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }

  if (!Number.isFinite(minX)) {
    return {
      minX: -30,
      maxX: 30,
      minY: -5,
      maxY: 5,
      minZ: -30,
      maxZ: 30
    };
  }

  return { minX, maxX, minY, maxY, minZ, maxZ };
}

function dedupePoints(points: TerrainPoint[]) {
  const map = new Map<string, TerrainPoint>();

  for (const p of points) {
    const key = `${p.x.toFixed(4)}|${p.y.toFixed(4)}|${p.z.toFixed(4)}`;
    if (!map.has(key)) {
      map.set(key, p);
    }
  }

  return Array.from(map.values());
}

function downsamplePoints(points: TerrainPoint[], maxPoints = 2500) {
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  return points.filter((_, i) => i % step === 0);
}

function createFallbackTerrainGeometry(size = 60, segments = 80) {
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  const pos = geometry.attributes.position;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getY(i);
    const y = fallbackDesignHeightAt(x, z);
    pos.setXYZ(i, x, y, z);
  }

  geometry.computeVertexNormals();
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function selectNearestPoints(points: TerrainPoint[], x: number, z: number, k = 8) {
  const best: { p: TerrainPoint; d2: number }[] = [];

  for (const p of points) {
    const dx = p.x - x;
    const dz = p.z - z;
    const d2 = dx * dx + dz * dz;

    if (best.length < k) {
      best.push({ p, d2 });
      best.sort((a, b) => a.d2 - b.d2);
      continue;
    }

    if (d2 < best[best.length - 1].d2) {
      best[best.length - 1] = { p, d2 };
      best.sort((a, b) => a.d2 - b.d2);
    }
  }

  return best;
}

function interpolateHeightFromPoints(points: TerrainPoint[], x: number, z: number) {
  if (points.length === 0) return 0;

  const nearest = selectNearestPoints(points, x, z, 8);
  if (nearest.length === 0) return 0;

  if (nearest[0].d2 < 1e-8) return nearest[0].p.y;

  let numerator = 0;
  let denominator = 0;

  for (const item of nearest) {
    const weight = 1 / Math.max(item.d2, 1e-8);
    numerator += item.p.y * weight;
    denominator += weight;
  }

  if (denominator === 0) return nearest[0].p.y;
  return numerator / denominator;
}

function barycentricHeight(tri: TerrainTriangle, x: number, z: number): number | null {
  const ax = tri.a.x;
  const az = tri.a.z;
  const bx = tri.b.x;
  const bz = tri.b.z;
  const cx = tri.c.x;
  const cz = tri.c.z;

  const denom = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(denom) < 1e-12) return null;

  const w1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / denom;
  const w2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / denom;
  const w3 = 1 - w1 - w2;

  const eps = 1e-8;
  if (w1 < -eps || w2 < -eps || w3 < -eps) return null;

  return w1 * tri.a.y + w2 * tri.b.y + w3 * tri.c.y;
}

function interpolateHeightFromTriangles(triangles: TerrainTriangle[], x: number, z: number) {
  for (const tri of triangles) {
    const y = barycentricHeight(tri, x, z);
    if (y !== null) return y;
  }
  return null;
}

function detectVerticalAxis(rawTriples: Array<[number, number, number]>) {
  if (rawTriples.length === 0) return 2;

  const mins = [Infinity, Infinity, Infinity];
  const maxs = [-Infinity, -Infinity, -Infinity];

  for (const triple of rawTriples) {
    for (let i = 0; i < 3; i++) {
      mins[i] = Math.min(mins[i], triple[i]);
      maxs[i] = Math.max(maxs[i], triple[i]);
    }
  }

  const spans = [maxs[0] - mins[0], maxs[1] - mins[1], maxs[2] - mins[2]];

  // LandXMLでは通常 3番目が標高だが、柔軟対応のため
  // 最も変化幅の小さい軸を高さ候補として採用
  let verticalAxis = 0;
  if (spans[1] < spans[verticalAxis]) verticalAxis = 1;
  if (spans[2] < spans[verticalAxis]) verticalAxis = 2;

  return verticalAxis;
}

function getUnitScaleFromXML(xml: XMLDocument) {
  const metricNodes = xml.getElementsByTagName("Metric");
  if (metricNodes.length === 0) return 1;

  const linearUnit = metricNodes[0].getAttribute("linearUnit")?.toLowerCase() ?? "meter";

  if (linearUnit.includes("millimeter")) return 0.001;
  if (linearUnit.includes("centimeter")) return 0.01;
  if (linearUnit.includes("meter")) return 1;
  return 1;
}

function getNodeLocalName(node: Element) {
  return node.localName ?? node.nodeName.split(":").pop() ?? node.nodeName;
}

function getDescendantsByLocalName(root: Element | XMLDocument, localName: string) {
  const matches: Element[] = [];
  const all = root.getElementsByTagName("*");
  for (const node of Array.from(all)) {
    if (getNodeLocalName(node) === localName) {
      matches.push(node);
    }
  }
  return matches;
}

function buildTINGeometry(points: TerrainPoint[], faceIndices: number[]) {
  const geometry = new THREE.BufferGeometry();
  const vertices = new Float32Array(points.length * 3);

  points.forEach((p, i) => {
    vertices[i * 3] = p.x;
    vertices[i * 3 + 1] = p.y;
    vertices[i * 3 + 2] = p.z;
  });

  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));

  if (faceIndices.length > 0) {
    geometry.setIndex(faceIndices);
  }

  geometry.computeVertexNormals();
  return geometry;
}

function buildPointCloudGeometry(points: TerrainPoint[]) {
  if (points.length === 0) {
    const geo = new THREE.PlaneGeometry(60, 60, 80, 80);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }

  const reduced = downsamplePoints(points, 2500);
  const bounds = computeBounds(reduced);
  const spanX = Math.max(bounds.maxX - bounds.minX, 10);
  const spanZ = Math.max(bounds.maxZ - bounds.minZ, 10);
  const segmentsX = 80;
  const segmentsZ = 80;

  const geometry = new THREE.PlaneGeometry(spanX, spanZ, segmentsX, segmentsZ);
  const pos = geometry.attributes.position;

  for (let i = 0; i < pos.count; i++) {
    const localX = pos.getX(i);
    const localZ = pos.getY(i);
    const y = interpolateHeightFromPoints(reduced, localX, localZ);
    pos.setXYZ(i, localX, y, localZ);
  }

  geometry.computeVertexNormals();
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function createSurfaceModel(params: {
  sourceName: string;
  surfaceId: string;
  surfaceName: string;
  rawPoints: TerrainPoint[];
  rawFaceIndices?: number[];
}) {
  const { sourceName, surfaceId, surfaceName, rawPoints, rawFaceIndices = [] } = params;

  const dedupedPoints = dedupePoints(rawPoints);
  const rawBounds = computeBounds(dedupedPoints);

  const offsetX = (rawBounds.minX + rawBounds.maxX) / 2;
  const offsetZ = (rawBounds.minZ + rawBounds.maxZ) / 2;
  const offsetY = rawBounds.minY;

  const normalizedPoints = dedupedPoints.map((p) => ({
    x: p.x - offsetX,
    y: p.y - offsetY,
    z: p.z - offsetZ
  }));

  const rawIndexToNormalizedIndex = new Map<number, number>();
  for (let i = 0; i < dedupedPoints.length; i++) {
    rawIndexToNormalizedIndex.set(i, i);
  }

  const normalizedTriangles: TerrainTriangle[] = [];

  if (rawFaceIndices.length > 0) {
    for (let i = 0; i < rawFaceIndices.length; i += 3) {
      const ia = rawFaceIndices[i];
      const ib = rawFaceIndices[i + 1];
      const ic = rawFaceIndices[i + 2];

      const a = normalizedPoints[ia];
      const b = normalizedPoints[ib];
      const c = normalizedPoints[ic];

      if (a && b && c) {
        normalizedTriangles.push({ a, b, c });
      }
    }
  }

  const geometry =
    normalizedTriangles.length > 0
      ? buildTINGeometry(normalizedPoints, rawFaceIndices)
      : buildPointCloudGeometry(normalizedPoints);

  const bounds = computeBounds(normalizedPoints);

  return {
    id: surfaceId,
    name: surfaceName,
    sourceName,
    points: normalizedPoints,
    triangles: normalizedTriangles,
    geometry,
    bounds,
    pointCount: normalizedPoints.length,
    triangleCount: normalizedTriangles.length,
    mode: normalizedTriangles.length > 0 ? ("tin" as const) : ("pointcloud" as const)
  };
}

function designHeightAt(surface: TerrainSurface | null, x: number, z: number) {
  if (!surface) {
    return fallbackDesignHeightAt(x, z);
  }

  if (surface.triangles.length > 0) {
    const y = interpolateHeightFromTriangles(surface.triangles, x, z);
    if (y !== null) return y;
  }

  if (surface.points.length > 0) {
    return interpolateHeightFromPoints(surface.points, x, z);
  }

  return fallbackDesignHeightAt(x, z);
}

function parseJSONTerrain(text: string, sourceName: string): TerrainModel {
  const json = JSON.parse(text);

  if (Array.isArray(json?.points)) {
    const points: TerrainPoint[] = json.points
      .map((p: any) => ({
        x: Number(p.x),
        y: Number(p.y),
        z: Number(p.z)
      }))
      .filter((p: TerrainPoint) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));

    if (points.length < 3) {
      throw new Error("JSON 内の points が不足しています。");
    }

    return {
      sourceName,
      surfaces: [
        createSurfaceModel({
          sourceName,
          surfaceId: "json-surface-0",
          surfaceName: "JSON Surface",
          rawPoints: points
        })
      ]
    };
  }

  if (Array.isArray(json?.triangles)) {
    const points: TerrainPoint[] = [];
    const faceIndices: number[] = [];

    for (const tri of json.triangles) {
      if (Array.isArray(tri.a) && Array.isArray(tri.b) && Array.isArray(tri.c)) {
        const baseIndex = points.length;
        points.push(
          { x: Number(tri.a[0]), y: Number(tri.a[1]), z: Number(tri.a[2]) },
          { x: Number(tri.b[0]), y: Number(tri.b[1]), z: Number(tri.b[2]) },
          { x: Number(tri.c[0]), y: Number(tri.c[1]), z: Number(tri.c[2]) }
        );
        faceIndices.push(baseIndex, baseIndex + 1, baseIndex + 2);
      }
    }

    const valid = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
    if (valid.length < 3) {
      throw new Error("JSON triangles の座標を読み取れませんでした。");
    }

    return {
      sourceName,
      surfaces: [
        createSurfaceModel({
          sourceName,
          surfaceId: "json-surface-0",
          surfaceName: "JSON Surface",
          rawPoints: points,
          rawFaceIndices: faceIndices
        })
      ]
    };
  }

  throw new Error("JSON形式は points か triangles を含んでいる必要があります。");
}

function parseTextTerrain(text: string, sourceName: string): TerrainModel {
  const lines = text
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const points: TerrainPoint[] = [];

  for (const line of lines) {
    const parts = line.split(/[,\s;]+/).filter(Boolean);
    if (parts.length < 3) continue;

    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const z = Number(parts[2]);

    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      points.push({ x, y, z });
    }
  }

  if (points.length < 3) {
    throw new Error("テキストから十分な座標点を読み取れませんでした。");
  }

  return {
    sourceName,
    surfaces: [
      createSurfaceModel({
        sourceName,
        surfaceId: "text-surface-0",
        surfaceName: "Text Surface",
        rawPoints: points
      })
    ]
  };
}

function extractCandidatePointsFromFloat64(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  const points: TerrainPoint[] = [];

  for (let offset = 0; offset <= buffer.byteLength - 24; offset += 8) {
    const x = view.getFloat64(offset, true);
    const y = view.getFloat64(offset + 8, true);
    const z = view.getFloat64(offset + 16, true);

    if (
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isFinite(z) &&
      Math.abs(x) < 1e8 &&
      Math.abs(y) < 1e6 &&
      Math.abs(z) < 1e8
    ) {
      if (!(Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12 && Math.abs(z) < 1e-12)) {
        points.push({ x, y, z });
      }
    }
  }

  return points;
}

function extractCandidatePointsFromFloat32(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  const points: TerrainPoint[] = [];

  for (let offset = 0; offset <= buffer.byteLength - 12; offset += 4) {
    const x = view.getFloat32(offset, true);
    const y = view.getFloat32(offset + 4, true);
    const z = view.getFloat32(offset + 8, true);

    if (
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isFinite(z) &&
      Math.abs(x) < 1e8 &&
      Math.abs(y) < 1e6 &&
      Math.abs(z) < 1e8
    ) {
      if (!(Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12 && Math.abs(z) < 1e-12)) {
        points.push({ x, y, z });
      }
    }
  }

  return points;
}

function scorePointCloud(points: TerrainPoint[]) {
  if (points.length < 10) return -Infinity;
  const deduped = dedupePoints(points);
  if (deduped.length < 10) return -Infinity;

  const bounds = computeBounds(deduped);
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  const spanZ = bounds.maxZ - bounds.minZ;

  if (spanX <= 0 || spanZ <= 0) return -Infinity;
  if (spanY > 1e5) return -Infinity;

  return deduped.length - spanY * 0.001;
}

function parseTP3Terrain(buffer: ArrayBuffer, sourceName: string): TerrainModel {
  const header = new TextDecoder("utf-8", { fatal: false }).decode(buffer.slice(0, 64));

  const float64Points = extractCandidatePointsFromFloat64(buffer);
  const float32Points = extractCandidatePointsFromFloat32(buffer);

  const score64 = scorePointCloud(float64Points);
  const score32 = scorePointCloud(float32Points);

  const chosen = score64 >= score32 ? float64Points : float32Points;

  if (chosen.length < 10) {
    throw new Error(
      "tp3 から十分な設計面点群を抽出できませんでした。独自仕様の可能性が高いため、座標仕様が分かれば精度をさらに上げられます。"
    );
  }

  console.info("TP3 header preview:", header);

  return {
    sourceName,
    surfaces: [
      createSurfaceModel({
        sourceName,
        surfaceId: "tp3-surface-0",
        surfaceName: "TP3 Surface",
        rawPoints: chosen
      })
    ]
  };
}

function parseLandXMLTerrain(text: string, sourceName: string): TerrainModel {
  const parser = new DOMParser();
  const xml = parser.parseFromString(text, "application/xml");

  const parserErrors = xml.getElementsByTagName("parsererror");
  if (parserErrors.length > 0) {
    throw new Error("XMLのパースに失敗しました。");
  }

  const scale = getUnitScaleFromXML(xml);
  const surfaceNodes = getDescendantsByLocalName(xml, "Surface");

  const surfaces: TerrainSurface[] = [];

  for (let s = 0; s < surfaceNodes.length; s++) {
    const surfaceNode = surfaceNodes[s];
    const surfaceName =
      surfaceNode.getAttribute("name") ||
      surfaceNode.getAttribute("desc") ||
      `Surface ${s + 1}`;

    const definitionNode = getDescendantsByLocalName(surfaceNode, "Definition").find((node) => {
      const surfType = node.getAttribute("surfType")?.toLowerCase();
      return surfType === "tin" || surfType === "tin surface";
    });

    if (!definitionNode) continue;

    const pNodes = getDescendantsByLocalName(definitionNode, "P");
    if (pNodes.length === 0) continue;

    const rawTriples: Array<[number, number, number]> = [];
    const idOrder: string[] = [];

    for (const pNode of pNodes) {
      const textValue = (pNode.textContent ?? "").trim();
      const parts = textValue.split(/[,\s]+/).filter(Boolean);
      if (parts.length < 3) continue;

      const a = Number(parts[0]) * scale;
      const b = Number(parts[1]) * scale;
      const c = Number(parts[2]) * scale;

      if (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c)) {
        rawTriples.push([a, b, c]);
        idOrder.push(pNode.getAttribute("id") ?? `${rawTriples.length}`);
      }
    }

    if (rawTriples.length < 3) continue;

    const verticalAxis = detectVerticalAxis(rawTriples);
    const horizontalAxes = [0, 1, 2].filter((axis) => axis !== verticalAxis);

    const rawPoints: TerrainPoint[] = rawTriples.map((triple) => ({
      x: triple[horizontalAxes[0]],
      y: triple[verticalAxis],
      z: triple[horizontalAxes[1]]
    }));

    const idToIndex = new Map<string, number>();
    idOrder.forEach((id, index) => {
      idToIndex.set(id, index);
    });

    const rawFaceIndices: number[] = [];
    const faceNodes = getDescendantsByLocalName(definitionNode, "F");

    for (const fNode of faceNodes) {
      const textValue = (fNode.textContent ?? "").trim();
      const parts = textValue.split(/[,\s]+/).filter(Boolean);
      if (parts.length < 3) continue;

      const a = idToIndex.get(parts[0]);
      const b = idToIndex.get(parts[1]);
      const c = idToIndex.get(parts[2]);

      if (a !== undefined && b !== undefined && c !== undefined) {
        rawFaceIndices.push(a, b, c);
      }
    }

    surfaces.push(
      createSurfaceModel({
        sourceName,
        surfaceId: `xml-surface-${s}`,
        surfaceName,
        rawPoints,
        rawFaceIndices
      })
    );
  }

  if (surfaces.length === 0) {
    throw new Error("LandXMLから有効なSurface/TINを抽出できませんでした。");
  }

  return {
    sourceName,
    surfaces
  };
}

async function parseTerrainFile(file: File): Promise<TerrainModel> {
  const lower = file.name.toLowerCase();

  if (lower.endsWith(".xml")) {
    const text = await file.text();
    return parseLandXMLTerrain(text, file.name);
  }

  throw new Error("対応形式は .xml です。");
}

function CameraRig({
  mode,
  target,
  activeSurface
}: {
  mode: ViewMode;
  target: THREE.Vector3;
  activeSurface: TerrainSurface | null;
}) {
  const { camera } = useThree();

  useEffect(() => {
    const span =
      activeSurface != null
        ? Math.max(
            activeSurface.bounds.maxX - activeSurface.bounds.minX,
            activeSurface.bounds.maxZ - activeSurface.bounds.minZ,
            30
          )
        : 60;

    if (mode === "iso") {
      camera.position.set(target.x + span * 0.2, target.y + span * 0.13, target.z + span * 0.2);
    } else if (mode === "top") {
      camera.position.set(target.x, target.y + span * 0.38, target.z + 0.01);
    } else {
      camera.position.set(target.x + span * 0.28, target.y + span * 0.08, target.z);
    }
    camera.lookAt(target);
  }, [camera, mode, target, activeSurface]);

  return null;
}

function Terrain({ activeSurface }: { activeSurface: TerrainSurface | null }) {
  const fallbackGeometry = useMemo(() => createFallbackTerrainGeometry(), []);

  const geometry = useMemo(() => {
    return activeSurface?.geometry ?? fallbackGeometry;
  }, [activeSurface, fallbackGeometry]);

  return (
    <mesh geometry={geometry} receiveShadow>
      <meshStandardMaterial color="#94a3b8" metalness={0.05} roughness={0.95} side={THREE.DoubleSide} />
    </mesh>
  );
}

function DesignCursor({
  bucketTip,
  activeSurface
}: {
  bucketTip: THREE.Vector3;
  activeSurface: TerrainSurface | null;
}) {
  const groundY = designHeightAt(activeSurface, bucketTip.x, bucketTip.z);
  const diff = bucketTip.y - groundY;
  const color = diffColor(diff);

  const line = useMemo(() => {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(bucketTip.x, groundY, bucketTip.z),
      new THREE.Vector3(bucketTip.x, bucketTip.y, bucketTip.z)
    ]);
    const material = new THREE.LineBasicMaterial({ color });
    return new THREE.Line(geometry, material);
  }, [bucketTip.x, bucketTip.y, bucketTip.z, groundY, color]);

  return (
    <>
      <mesh position={[bucketTip.x, groundY, bucketTip.z]}>
        <cylinderGeometry args={[0.45, 0.45, 0.05, 32]} />
        <meshStandardMaterial color={color} />
      </mesh>

      <primitive object={line} />
    </>
  );
}

function Excavator({
  telemetry,
  onBucketTipComputed
}: {
  telemetry: Telemetry;
  onBucketTipComputed: (tip: THREE.Vector3) => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const boomRef = useRef<THREE.Group>(null);
  const armRef = useRef<THREE.Group>(null);
  const bucketRef = useRef<THREE.Group>(null);

  const boomLength = 4.5;
  const armLength = 3.5;
  const bucketOffset = 0.8;

  useFrame(() => {
    if (!groupRef.current || !boomRef.current || !armRef.current || !bucketRef.current) return;

    const { machine, joints } = telemetry;

    groupRef.current.position.set(machine.x, machine.y, machine.z);
    groupRef.current.rotation.y = degToRad(machine.yawDeg);

    boomRef.current.rotation.z = degToRad(clamp(joints.boomDeg, -10, 75));
    armRef.current.rotation.z = degToRad(clamp(joints.armDeg, -150, 20));
    bucketRef.current.rotation.z = degToRad(clamp(joints.bucketDeg * 0.5, -60, 60));

    const localTip = new THREE.Vector3(bucketOffset, -0.3, 0);
    const worldTip = bucketRef.current.localToWorld(localTip.clone());
    onBucketTipComputed(worldTip);
  });

  return (
    <group ref={groupRef}>
      <group position={[0, 0.7, 0]}>
        <mesh position={[0, -0.35, 0]}>
          <boxGeometry args={[4.6, 0.4, 2.6]} />
          <meshStandardMaterial color="#1f2937" />
        </mesh>

        <mesh position={[0, 0.1, 0]}>
          <boxGeometry args={[3.4, 0.8, 2.2]} />
          <meshStandardMaterial color="#f59e0b" />
        </mesh>

        <mesh position={[0.5, 0.95, 0]}>
          <boxGeometry args={[1.2, 0.9, 1.3]} />
          <meshStandardMaterial color="#fbbf24" />
        </mesh>

        <group position={[1.2, 1.0, 0]}>
          <group ref={boomRef}>
            <mesh position={[boomLength / 2, 0, 0]}>
              <boxGeometry args={[boomLength, 0.35, 0.35]} />
              <meshStandardMaterial color="#f59e0b" />
            </mesh>

            <group ref={armRef} position={[boomLength, 0, 0]}>
              <mesh position={[armLength / 2, 0, 0]}>
                <boxGeometry args={[armLength, 0.28, 0.28]} />
                <meshStandardMaterial color="#fbbf24" />
              </mesh>

              <group ref={bucketRef} position={[armLength, 0, 0]}>
                <mesh position={[0.3, -0.25, 0]}>
                  <boxGeometry args={[0.9, 0.6, 0.5]} />
                  <meshStandardMaterial color="#64748b" />
                </mesh>

                <mesh position={[0.6, -0.5, 0]}>
                  <boxGeometry args={[0.2, 0.4, 0.3]} />
                  <meshStandardMaterial color="#475569" />
                </mesh>
              </group>
            </group>
          </group>
        </group>
      </group>
    </group>
  );
}

function Scene({
  telemetry,
  viewMode,
  onBucketTipComputed,
  activeSurface
}: {
  telemetry: Telemetry;
  viewMode: ViewMode;
  onBucketTipComputed: (tip: THREE.Vector3) => void;
  activeSurface: TerrainSurface | null;
}) {
  const target = useMemo(
    () => new THREE.Vector3(telemetry.machine.x, telemetry.machine.y + 1.5, telemetry.machine.z),
    [telemetry.machine.x, telemetry.machine.y, telemetry.machine.z]
  );

  const [bucketTip, setBucketTip] = useState(new THREE.Vector3());

  useEffect(() => {
    onBucketTipComputed(bucketTip);
  }, [bucketTip, onBucketTipComputed]);

  return (
    <>
      <CameraRig mode={viewMode} target={target} activeSurface={activeSurface} />

      <ambientLight intensity={1.2} />
      <directionalLight position={[10, 20, 10]} intensity={1.5} castShadow />
      <hemisphereLight groundColor="#334155" intensity={0.55} />

      <Grid
        args={[60, 60]}
        cellSize={1}
        cellThickness={0.6}
        sectionSize={5}
        sectionThickness={1.2}
        fadeDistance={80}
        fadeStrength={1}
        infiniteGrid={false}
      />

      <Terrain activeSurface={activeSurface} />

      <mesh position={[0, -0.02, 0]} receiveShadow rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[80, 80]} />
        <shadowMaterial opacity={0.15} />
      </mesh>

      <Excavator
        telemetry={telemetry}
        onBucketTipComputed={(tip) => {
          setBucketTip(tip.clone());
          onBucketTipComputed(tip.clone());
        }}
      />

      <DesignCursor bucketTip={bucketTip} activeSurface={activeSurface} />

      <mesh position={[bucketTip.x, bucketTip.y, bucketTip.z]}>
        <sphereGeometry args={[0.16, 24, 24]} />
        <meshStandardMaterial color={diffColor(bucketTip.y - designHeightAt(activeSurface, bucketTip.x, bucketTip.z))} />
      </mesh>

      <Html position={[telemetry.machine.x, telemetry.machine.y + 4.5, telemetry.machine.z]}>
        <div
          style={{
            padding: "6px 10px",
            background: "rgba(15,23,42,0.82)",
            borderRadius: 10,
            color: "white",
            fontSize: 12,
            border: "1px solid rgba(148,163,184,0.4)"
          }}
        >
          Excavator
        </div>
      </Html>

      <OrbitControls makeDefault target={target} enablePan={true} />
    </>
  );
}

export default function App() {
  const [telemetry, setTelemetry] = useState<Telemetry>(defaultTelemetry);
  const [connected, setConnected] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("iso");
  const [bucketTip, setBucketTip] = useState(new THREE.Vector3());
  const [terrainModel, setTerrainModel] = useState<TerrainModel | null>(null);
  const [activeSurfaceId, setActiveSurfaceId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [loadedFileName, setLoadedFileName] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const connect = () => {
      ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        setConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const next = JSON.parse(event.data) as Telemetry;
          setTelemetry(next);
        } catch (err) {
          console.error("telemetry parse error", err);
        }
      };

      ws.onclose = () => {
        setConnected(false);
        reconnectTimer = window.setTimeout(connect, 1000);
      };

      ws.onerror = () => {
        setConnected(false);
        ws?.close();
      };
    };

    connect();

    return () => {
      ws?.close();
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
    };
  }, []);

  const activeSurface = useMemo(() => {
    if (!terrainModel) return null;
    return terrainModel.surfaces.find((surface) => surface.id === activeSurfaceId) ?? terrainModel.surfaces[0] ?? null;
  }, [terrainModel, activeSurfaceId]);

  const handleFileUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setLoading(true);

    try {
      const model = await parseTerrainFile(file);
      setTerrainModel(model);
      setLoadedFileName(file.name);
      setActiveSurfaceId(model.surfaces[0]?.id ?? "");
    } catch (error) {
      console.error("Error loading terrain file:", error);

      const message =
        error instanceof Error
          ? error.message
          : "設計面ファイルの読込に失敗しました。";

      alert(
        [
          "このファイルは設計面として読み込めませんでした。",
          "",
          message,
          "",
          "対応形式は .xml  です。"
        ].join("\n")
      );
    } finally {
      setLoading(false);
      event.target.value = "";
    }
  }, []);

  const designY = designHeightAt(activeSurface, bucketTip.x, bucketTip.z);
  const diff = bucketTip.y - designY;

  return (
    <div className="app-shell">
      <div className="hud">
        <h1>SMART PILOT CLONE</h1>
        <div className="subtitle">ローカル検証用 3D マシンガイダンス</div>

        <div style={{ marginBottom: "20px" }}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xml"
            onChange={handleFileUpload}
            style={{ display: "none" }}
          />
          <button onClick={() => fileInputRef.current?.click()}>
            設計面ファイルを読込 (.xml)
          </button>
          {loading && <span style={{ marginLeft: 10 }}>Loading...</span>}
          {loadedFileName && (
            <div style={{ marginTop: 8, fontSize: 12, color: "#cbd5e1" }}>
              読込済み: {loadedFileName}
              {activeSurface
                ? ` / ${activeSurface.name} / ${activeSurface.pointCount} pts / ${activeSurface.triangleCount} tris`
                : ""}
            </div>
          )}
        </div>

        {terrainModel && terrainModel.surfaces.length > 1 && (
          <div style={{ marginBottom: "16px" }}>
            <div style={{ fontSize: 12, marginBottom: 6 }}>Surface選択</div>
            <select
              value={activeSurfaceId}
              onChange={(e) => setActiveSurfaceId(e.target.value)}
              style={{
                width: "100%",
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid #475569",
                background: "#0f172a",
                color: "#e2e8f0"
              }}
            >
              {terrainModel.surfaces.map((surface) => (
                <option key={surface.id} value={surface.id}>
                  {surface.name} ({surface.mode})
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="hud-grid">
          <div className="card">
            <div className="label">接続状態</div>
            <div className="value">
              <span className={connected ? "conn-ok" : "conn-bad"}>
                {connected ? "ONLINE" : "OFFLINE"}
              </span>
            </div>
          </div>

          <div className="card">
            <div className="label">Payload</div>
            <div className="value">{telemetry.payloadKg.toFixed(0)} kg</div>
          </div>

          <div className="card">
            <div className="label">バケット先端高低差</div>
            <div className="value" style={{ color: diffColor(diff) }}>
              {diff >= 0 ? "+" : ""}
              {diff.toFixed(2)} m
            </div>
          </div>

          <div className="card">
            <div className="label">走行速度</div>
            <div className="value">{telemetry.speedKph.toFixed(1)} km/h</div>
          </div>

          <div className="card">
            <div className="label">機体位置</div>
            <div className="value" style={{ fontSize: 15 }}>
              X {telemetry.machine.x.toFixed(2)} / Y {telemetry.machine.y.toFixed(2)} / Z{" "}
              {telemetry.machine.z.toFixed(2)}
            </div>
          </div>

          <div className="card">
            <div className="label">関節角度</div>
            <div className="value" style={{ fontSize: 15 }}>
              B {telemetry.joints.boomDeg.toFixed(1)}° / A {telemetry.joints.armDeg.toFixed(1)}° / K{" "}
              {telemetry.joints.bucketDeg.toFixed(1)}°
            </div>
          </div>
        </div>

        <div className="controls">
          <button onClick={() => setViewMode("iso")}>アイソビュー</button>
          <button className="secondary" onClick={() => setViewMode("top")}>
            平面ビュー
          </button>
          <button className="secondary" onClick={() => setViewMode("side")}>
            側面ビュー
          </button>
        </div>

        <div className="legend">
          <div>
            <span className="status-dot" style={{ background: "#22c55e" }} /> 設計面に近い
          </div>
          <div>
            <span className="status-dot" style={{ background: "#ef4444" }} /> 設計面より上
          </div>
          <div>
            <span className="status-dot" style={{ background: "#3b82f6" }} /> 設計面より下
          </div>
        </div>
      </div>

      <div className="bottom-bar">
        <div className="bottom-card">
          <div className="bottom-title">バケット先端</div>
          <div className="bottom-value">
            X {bucketTip.x.toFixed(2)} / Y {bucketTip.y.toFixed(2)} / Z {bucketTip.z.toFixed(2)}
          </div>
        </div>
        <div className="bottom-card">
          <div className="bottom-title">設計面高さ</div>
          <div className="bottom-value">{designY.toFixed(2)} m</div>
        </div>
        <div className="bottom-card">
          <div className="bottom-title">機体方位</div>
          <div className="bottom-value">{telemetry.machine.yawDeg.toFixed(1)}°</div>
        </div>
      </div>

      <Canvas shadows camera={{ position: [12, 8, 12], fov: 50 }}>
        <Scene
          telemetry={telemetry}
          viewMode={viewMode}
          onBucketTipComputed={(tip) => setBucketTip(tip)}
          activeSurface={activeSurface}
        />
      </Canvas>
    </div>
  );
}