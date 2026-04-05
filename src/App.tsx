import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Grid, OrbitControls, Html } from "@react-three/drei";
import React, { useEffect, useMemo, useRef, useState } from "react";
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

function designHeightAt(x: number, z: number) {
  // ローカル検証用の設計面
  return 0.18 * Math.sin(x * 0.22) + 0.12 * Math.cos(z * 0.18) - 0.035 * z;
}

function diffColor(diff: number) {
  if (Math.abs(diff) < 0.1) return "#22c55e";
  if (diff > 0) return "#ef4444";
  return "#3b82f6";
}

function createTerrainGeometry(size = 60, segments = 80) {
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getY(i);
    const y = designHeightAt(x, z);
    pos.setXYZ(i, x, y, z);
  }
  geometry.computeVertexNormals();
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function CameraRig({ mode, target }: { mode: ViewMode; target: THREE.Vector3 }) {
  const { camera } = useThree();

  useEffect(() => {
    if (mode === "iso") {
      camera.position.set(target.x + 12, target.y + 8, target.z + 12);
    } else if (mode === "top") {
      camera.position.set(target.x, target.y + 22, target.z + 0.01);
    } else {
      camera.position.set(target.x + 18, target.y + 5, target.z);
    }
    camera.lookAt(target);
  }, [camera, mode, target]);

  return null;
}

function Terrain() {
  const geometry = useMemo(() => createTerrainGeometry(), []);
  return (
    <mesh geometry={geometry} receiveShadow>
      <meshStandardMaterial color="#94a3b8" metalness={0.05} roughness={0.95} />
    </mesh>
  );
}

function DesignCursor({
  bucketTip
}: {
  bucketTip: THREE.Vector3;
}) {
  const groundY = designHeightAt(bucketTip.x, bucketTip.z);
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

  // 実機寄せの比率
  const boomLength = 4.5;
  const armLength = 3.5;
  const bucketOffset = 0.8;

  useFrame(() => {
    if (!groupRef.current || !boomRef.current || !armRef.current || !bucketRef.current) return;

    const { machine, joints } = telemetry;

    groupRef.current.position.set(machine.x, machine.y, machine.z);
    groupRef.current.rotation.y = degToRad(machine.yawDeg);

    // ★2段折り構造
    boomRef.current.rotation.z = degToRad(joints.boomDeg);
    armRef.current.rotation.z = degToRad(joints.armDeg);

    // バケットは微調整のみ（強く曲げない）
    bucketRef.current.rotation.z = degToRad(joints.bucketDeg * 0.5);

    // 先端計算
    const localTip = new THREE.Vector3(bucketOffset, -0.3, 0);
    const worldTip = bucketRef.current.localToWorld(localTip.clone());
    onBucketTipComputed(worldTip);
  });

  return (
    <group ref={groupRef}>
      <group position={[0, 0.7, 0]}>
        
        {/* クローラ */}
        <mesh position={[0, -0.35, 0]}>
          <boxGeometry args={[4.6, 0.4, 2.6]} />
          <meshStandardMaterial color="#1f2937" />
        </mesh>

        {/* 上部旋回体 */}
        <mesh position={[0, 0.1, 0]}>
          <boxGeometry args={[3.4, 0.8, 2.2]} />
          <meshStandardMaterial color="#f59e0b" />
        </mesh>

        {/* キャビン */}
        <mesh position={[0.5, 0.95, 0]}>
          <boxGeometry args={[1.2, 0.9, 1.3]} />
          <meshStandardMaterial color="#fbbf24" />
        </mesh>

        {/* ブーム基部 */}
        <group position={[1.2, 1.0, 0]}>
          
          {/* ★ ブーム（1段目） */}
          <group ref={boomRef}>
            <mesh position={[boomLength / 2, 0, 0]}>
              <boxGeometry args={[boomLength, 0.35, 0.35]} />
              <meshStandardMaterial color="#f59e0b" />
            </mesh>

            {/* ★ アーム（2段目） */}
            <group ref={armRef} position={[boomLength, 0, 0]}>
              <mesh position={[armLength / 2, 0, 0]}>
                <boxGeometry args={[armLength, 0.28, 0.28]} />
                <meshStandardMaterial color="#fbbf24" />
              </mesh>

              {/* ★ バケット（先端ツール） */}
              <group ref={bucketRef} position={[armLength, 0, 0]}>
                
                {/* バケット本体 */}
                <mesh position={[0.3, -0.25, 0]}>
                  <boxGeometry args={[0.9, 0.6, 0.5]} />
                  <meshStandardMaterial color="#64748b" />
                </mesh>

                {/* 爪（それっぽさ強化） */}
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
  onBucketTipComputed
}: {
  telemetry: Telemetry;
  viewMode: ViewMode;
  onBucketTipComputed: (tip: THREE.Vector3) => void;
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
      <CameraRig mode={viewMode} target={target} />

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

      <Terrain />

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

      <DesignCursor bucketTip={bucketTip} />

      <mesh position={[bucketTip.x, bucketTip.y, bucketTip.z]}>
        <sphereGeometry args={[0.16, 24, 24]} />
        <meshStandardMaterial color={diffColor(bucketTip.y - designHeightAt(bucketTip.x, bucketTip.z))} />
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

  const designY = designHeightAt(bucketTip.x, bucketTip.z);
  const diff = bucketTip.y - designY;

  return (
    <div className="app-shell">
      <div className="hud">
        <h1>SMART PILOT CLONE</h1>
        <div className="subtitle">
          ローカル検証用 3D マシンガイダンス
        </div>

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
              X {telemetry.machine.x.toFixed(2)} / Y {telemetry.machine.y.toFixed(2)} / Z {telemetry.machine.z.toFixed(2)}
            </div>
          </div>

          <div className="card">
            <div className="label">関節角度</div>
            <div className="value" style={{ fontSize: 15 }}>
              B {telemetry.joints.boomDeg.toFixed(1)}° / A {telemetry.joints.armDeg.toFixed(1)}° / K {telemetry.joints.bucketDeg.toFixed(1)}°
            </div>
          </div>
        </div>

        <div className="controls">
          <button onClick={() => setViewMode("iso")}>アイソビュー</button>
          <button className="secondary" onClick={() => setViewMode("top")}>平面ビュー</button>
          <button className="secondary" onClick={() => setViewMode("side")}>側面ビュー</button>
        </div>

        <div className="legend">
          <div><span className="status-dot" style={{ background: "#22c55e" }} /> 設計面に近い</div>
          <div><span className="status-dot" style={{ background: "#ef4444" }} /> 設計面より上</div>
          <div><span className="status-dot" style={{ background: "#3b82f6" }} /> 設計面より下</div>
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
        />
      </Canvas>
    </div>
  );
}