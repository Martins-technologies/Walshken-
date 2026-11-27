import type { NextConfig } from "next";

const documentRendererAssets = ["./public/inter-latin.woff2","./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs","./node_modules/pdfjs-dist/standard_fonts/**/*","./node_modules/pdfjs-dist/cmaps/**/*","./node_modules/pdfjs-dist/wasm/**/*","./node_modules/@napi-rs/canvas-linux-x64-gnu/**/*"];

const config: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["@electric-sql/pglite", "postgres", "pg", "pdfjs-dist", "@napi-rs/canvas", "mammoth", "exceljs", "yauzl"],
  outputFileTracingIncludes: {
    "/api/client-finance": ["./public/payroll-font.ttf"],
    "/api/client-finance/staff": ["./public/payroll-font.ttf"],
    "/api/staff-performance": ["./public/payroll-font.ttf"],
    "/api/payroll/*": ["./public/payroll-font.ttf"],
    "/api/documents/*": documentRendererAssets,
    "/api/tasks/*": documentRendererAssets,
    "/api/client-documents/*": documentRendererAssets,
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=()" },
      ],
    }, {
      source: "/customer/:path*",
      headers: [
        { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(), display-capture=()" },
        { key: "Cache-Control", value: "private, no-store" },
      ],
    }];
  },
};
export default config;
