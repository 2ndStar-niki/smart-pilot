import { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: 8787 });

console.log("mock telemetry server started: ws://localhost:8787");

function makeTelemetry(t) {
  const x = Math.sin(t * 0.00035) * 8;
  const z = Math.cos(t * 0.00022) * 10;
  const yawDeg = ((t * 0.01) % 360);

  const boomDeg = 42 + Math.sin(t * 0.0014) * 16;
  const armDeg = -35 + Math.cos(t * 0.0017) * 18;
  const bucketDeg = 22 + Math.sin(t * 0.0022) * 24;
  const payloadKg = 420 + 180 * (1 + Math.sin(t * 0.0011));
  const speedKph = 2.2 + Math.abs(Math.sin(t * 0.0019)) * 3.5;

  return {
    timestamp: Date.now(),
    machine: {
      x,
      y: 0,
      z,
      yawDeg
    },
    joints: {
      boomDeg,
      armDeg,
      bucketDeg
    },
    payloadKg,
    speedKph
  };
}

setInterval(() => {
  const payload = JSON.stringify(makeTelemetry(Date.now()));
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}, 100);

wss.on("connection", () => {
  console.log("client connected");
});