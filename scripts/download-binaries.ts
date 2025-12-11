#!/usr/bin/env -S deno run --allow-net --allow-write --allow-read --allow-env

/**
 * Download FFI binaries from GitHub releases and install them to jn-ec-master-lib/ folder
 *
 * Usage:
 *   deno run -A scripts/download-binaries.ts [version]
 *
 * If version is not specified, downloads the latest release.
 * Version can be a tag name (e.g., "v1.0.0") or "latest"
 */

interface GitHubRelease {
  tag_name: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
}

async function getRelease(
  owner: string,
  repo: string,
  version?: string,
): Promise<GitHubRelease> {
  const url = version && version !== "latest"
    ? `https://api.github.com/repos/${owner}/${repo}/releases/tags/${version}`
    : `https://api.github.com/repos/${owner}/${repo}/releases/latest`;

  console.log(`Fetching release: ${version || "latest"}...`);
  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Release not found: ${version || "latest"}`);
    }
    throw new Error(`Failed to fetch release: ${response.statusText}`);
  }

  return await response.json();
}

async function downloadFile(url: string, dest: string): Promise<void> {
  console.log(`Downloading ${url}...`);
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.statusText}`);
  }

  // Streamless write avoids double-close "Bad resource ID" errors on some Deno versions
  const data = new Uint8Array(await response.arrayBuffer());
  await Deno.writeFile(dest, data);
}

async function extractZip(zipPath: string, extractTo: string): Promise<void> {
  // Use Deno's built-in unzip or a simple implementation
  // For now, we'll use a simple approach with the standard library
  const command = new Deno.Command("unzip", {
    args: ["-o", zipPath, "-d", extractTo],
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await command.output();

  if (code !== 0) {
    const errorText = new TextDecoder().decode(stderr);
    throw new Error(`Failed to extract zip: ${errorText}`);
  }

  console.log(new TextDecoder().decode(stdout));
}

async function main() {
  const version = Deno.args[0];

  try {
    // Get GitHub owner and repo
    const owner = "jasper-node";
    const repo = "jn-ec-master";
    console.log(`Using repository: ${owner}/${repo}`);

    // Get release information
    const release = await getRelease(owner, repo, version);
    console.log(`Found release: ${release.tag_name}`);

    // Find the lib-binaries.zip asset
    const zipAsset = release.assets.find((asset) => asset.name === "lib-binaries.zip");

    if (!zipAsset) {
      throw new Error("lib-binaries.zip not found in release assets");
    }

    // Create temporary directory
    const tempDir = await Deno.makeTempDir({ prefix: "ethercat-binaries-" });
    const zipPath = `${tempDir}/lib-binaries.zip`;
    const extractDir = `${tempDir}/extracted`;

    try {
      // Download zip file
      await downloadFile(zipAsset.browser_download_url, zipPath);

      // Extract zip
      await Deno.mkdir(extractDir, { recursive: true });
      await extractZip(zipPath, extractDir);

      // Copy all platform binaries into jn-ec-master-lib/ (no renaming) so packages ship every target
      const extractedFiles = [];
      for await (const entry of Deno.readDir(extractDir)) {
        if (entry.isFile && entry.name.startsWith("libethercrab_ffi")) {
          extractedFiles.push(entry.name);
        }
      }

      if (extractedFiles.length === 0) {
        throw new Error("No libethercrab_ffi binaries found in extracted archive");
      }

      await Deno.mkdir("jn-ec-master-lib", { recursive: true });

      for (const filename of extractedFiles) {
        const sourcePath = `${extractDir}/${filename}`;
        const targetPath = `jn-ec-master-lib/${filename}`;

        await Deno.copyFile(sourcePath, targetPath);

        // Make executable on non-Windows platforms
        if (!filename.endsWith(".dll")) {
          await Deno.chmod(targetPath, 0o755);
        }

        console.log(`Installed ${filename} → ${targetPath}`);
      }

      console.log(`✅ Successfully installed all platform binaries to jn-ec-master-lib/`);
      console.log(`   Release: ${release.tag_name}`);
    } finally {
      // Cleanup temporary directory
      await Deno.remove(tempDir, { recursive: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("❌ Error:", message);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
