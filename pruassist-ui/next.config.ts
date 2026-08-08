import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow the app to be reached through an HTTPS tunnel (so customers can join
  // from another device — phone, second laptop — where browsers require HTTPS
  // for camera/mic). Covers quick-tunnel providers.
  allowedDevOrigins: ["*.trycloudflare.com", "*.loca.lt", "*.ngrok-free.app", "*.ngrok-free.dev", "*.ngrok.app", "*.ngrok.io"],
};

export default nextConfig;
