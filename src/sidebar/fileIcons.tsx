import React from "react";
import { Icon } from "@iconify/react";

// Highest precedence: exact filename (lowercased) → icon name
const BY_NAME: Record<string, string> = {
  "package.json": "vscode-icons:file-type-node",
  "package-lock.json": "vscode-icons:file-type-node",
  "tsconfig.json": "vscode-icons:file-type-tsconfig",
  "tsconfig.build.json": "vscode-icons:file-type-tsconfig",
  "cargo.toml": "vscode-icons:file-type-cargo",
  "cargo.lock": "vscode-icons:file-type-cargo",
  "dockerfile": "vscode-icons:file-type-docker",
  "docker-compose.yml": "vscode-icons:file-type-docker",
  "docker-compose.yaml": "vscode-icons:file-type-docker",
  ".gitignore": "vscode-icons:file-type-git",
  ".gitattributes": "vscode-icons:file-type-git",
  ".gitmodules": "vscode-icons:file-type-git",
  "readme.md": "vscode-icons:file-type-markdown",
  "license": "vscode-icons:file-type-license",
  "licence": "vscode-icons:file-type-license",
  "yarn.lock": "vscode-icons:file-type-yarn",
  "pnpm-lock.yaml": "vscode-icons:file-type-pnpm",
  ".env": "vscode-icons:file-type-dotenv",
  ".env.local": "vscode-icons:file-type-dotenv",
  ".env.development": "vscode-icons:file-type-dotenv",
  ".env.production": "vscode-icons:file-type-dotenv",
};

// Extension (lowercased, without leading dot) → icon name
const BY_EXT: Record<string, string> = {
  ts: "vscode-icons:file-type-typescript",
  tsx: "vscode-icons:file-type-reactts",
  js: "vscode-icons:file-type-js",
  jsx: "vscode-icons:file-type-reactjs",
  mjs: "vscode-icons:file-type-js",
  cjs: "vscode-icons:file-type-js",
  rs: "vscode-icons:file-type-rust",
  py: "vscode-icons:file-type-python",
  go: "vscode-icons:file-type-go",
  rb: "vscode-icons:file-type-ruby",
  java: "vscode-icons:file-type-java",
  kt: "vscode-icons:file-type-kotlin",
  swift: "vscode-icons:file-type-swift",
  c: "vscode-icons:file-type-c",
  h: "vscode-icons:file-type-cheader",
  cpp: "vscode-icons:file-type-cpp",
  cc: "vscode-icons:file-type-cpp",
  cxx: "vscode-icons:file-type-cpp",
  hpp: "vscode-icons:file-type-cppheader",
  hxx: "vscode-icons:file-type-cppheader",
  md: "vscode-icons:file-type-markdown",
  mdx: "vscode-icons:file-type-markdown",
  json: "vscode-icons:file-type-json",
  jsonc: "vscode-icons:file-type-json",
  yaml: "vscode-icons:file-type-yaml",
  yml: "vscode-icons:file-type-yaml",
  toml: "vscode-icons:file-type-toml",
  html: "vscode-icons:file-type-html",
  htm: "vscode-icons:file-type-html",
  css: "vscode-icons:file-type-css",
  scss: "vscode-icons:file-type-scss",
  sass: "vscode-icons:file-type-sass",
  less: "vscode-icons:file-type-less",
  png: "vscode-icons:file-type-image",
  jpg: "vscode-icons:file-type-image",
  jpeg: "vscode-icons:file-type-image",
  gif: "vscode-icons:file-type-image",
  webp: "vscode-icons:file-type-image",
  svg: "vscode-icons:file-type-svg",
  pdf: "vscode-icons:file-type-pdf2",
  sh: "vscode-icons:file-type-shell",
  bash: "vscode-icons:file-type-shell",
  zsh: "vscode-icons:file-type-shell",
  fish: "vscode-icons:file-type-shell",
  sql: "vscode-icons:file-type-sql",
  vue: "vscode-icons:file-type-vue",
  svelte: "vscode-icons:file-type-svelte",
  graphql: "vscode-icons:file-type-graphql",
  gql: "vscode-icons:file-type-graphql",
  proto: "vscode-icons:file-type-protobuf",
};

const FOLDER_ICON = "vscode-icons:default-folder";
const FOLDER_OPEN_ICON = "vscode-icons:default-folder-opened";
const FILE_FALLBACK = "vscode-icons:default-file";

export function FileIcon({
  name,
  isDir,
  isExpanded,
}: {
  name: string;
  isDir: boolean;
  isExpanded?: boolean;
}) {
  let iconName: string;
  if (isDir) {
    iconName = isExpanded ? FOLDER_OPEN_ICON : FOLDER_ICON;
  } else {
    const lower = name.toLowerCase();
    if (BY_NAME[lower]) {
      iconName = BY_NAME[lower];
    } else {
      const ext = lower.match(/\.([a-z0-9]+)$/)?.[1];
      iconName = (ext && BY_EXT[ext]) || FILE_FALLBACK;
    }
  }
  return <Icon icon={iconName} width={14} height={14} />;
}
