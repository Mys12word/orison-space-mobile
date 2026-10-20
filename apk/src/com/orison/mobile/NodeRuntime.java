package com.orison.mobile;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Runs the Orison Space Node host (the desktop app's main-process service layer,
 * bundled with a Node runtime) inside the APK.
 *
 * Assets layout:
 *   assets/runtime/VERSION        version stamp (bump ⇒ re-extract)
 *   assets/runtime/node           Node runtime for arm64-v8a
 *   assets/runtime/lib/*.so       Node shared-library dependencies
 *   assets/runtime/lib/ossl-modules/*.so  OpenSSL provider modules
 *   assets/runtime/etc/*          openssl.cnf + cert.pem
 *   assets/runtime/host/**        esbuild host bundle (server.js + chunks)
 *   assets/runtime/web/**         Vite renderer build (the UI)
 *
 * The Termux-built node binary has the Termux prefix compiled into libcrypto
 * (OPENSSLDIR / MODULESDIR). Inside a different app sandbox those paths are not
 * readable, which makes OpenSSL abort at startup, so every start pins
 * OPENSSL_CONF / OPENSSL_MODULES to the copies bundled in the APK.
 */
public final class NodeRuntime {
    private static final String TAG = "OrisonNode";

    private static Process process;
    private static Thread logPump;
    private static File logFile;
    private static int currentPort = 0;

    private NodeRuntime() {}

    public static final class StartupException extends Exception {
        public StartupException(String message) { super(message); }
    }

    public static String version(Context context) {
        try {
            return readText(context.getAssets(), "runtime/VERSION").trim();
        } catch (IOException err) {
            return "0";
        }
    }

    /** True until the bundled runtime has been unpacked (first launch). */
    public static boolean needsExtraction(Context context) {
        File runtime = new File(new File(context.getFilesDir(), "orison"), "runtime-" + version(context));
        return !new File(runtime, ".stamp").exists();
    }

    /** Starts the host if not already running and blocks until the port accepts connections. */
    public static synchronized int start(Context context) throws StartupException {
        if (process != null && process.isAlive()) {
            return currentPort;
        }
        try {
            File root = new File(context.getFilesDir(), "orison");
            File logs = new File(root, "logs");
            mkdirs(logs);
            logFile = new File(logs, "node.log");

            String version = version(context);
            File runtime = new File(root, "runtime-" + version);
            File stamp = new File(runtime, ".stamp");
            if (!stamp.exists()) {
                deleteRecursive(runtime);
                mkdirs(runtime);
                extractAssets(context.getAssets(), "runtime", runtime);
                setPermissions(runtime);
                writeFile(stamp, version);
            }

            File home = new File(root, "home");
            File data = new File(root, "data");
            File tmp = new File(root, "tmp");
            mkdirs(home);
            mkdirs(data);
            mkdirs(tmp);
            File external = context.getExternalFilesDir(null);
            File projects = external != null ? new File(external, "OrisonSpace") : new File(root, "OrisonSpace");
            mkdirs(projects);

            File node = new File(runtime, "node");
            if (!node.isFile()) throw new StartupException("runtime is missing the node binary");
            if (!node.canExecute() && !node.setExecutable(true, false)) {
                throw new StartupException("cannot mark node executable");
            }
            File server = new File(runtime, "host/server.js");
            if (!server.isFile()) throw new StartupException("runtime is missing host/server.js");

            int port = findFreePort();
            File opensslConf = new File(runtime, "etc/openssl.cnf");
            File opensslModules = new File(runtime, "lib/ossl-modules");

            String appVersion = packageVersion(context);
            process = launch(runtime, node, server, port, home, data, projects, tmp, opensslConf, opensslModules, appVersion);
            startLogPump();
            try {
                waitForPort(port, 45000);
            } catch (StartupException first) {
                // Retry once with a config-free OpenSSL: covers the "baked
                // Termux OPENSSLDIR is unreadable" family of startup failures.
                Log.w(TAG, "first launch attempt failed, retrying with OPENSSL_CONF=/dev/null", first);
                stop();
                process = launch(runtime, node, server, port, home, data, projects, tmp, new File("/dev/null"), opensslModules, appVersion);
                startLogPump();
                waitForPort(port, 45000);
            }
            currentPort = port;
            Log.i(TAG, "host ready on port " + port);
            return port;
        } catch (StartupException err) {
            throw err;
        } catch (Exception err) {
            stop();
            throw new StartupException(describe(err));
        }
    }

    private static Process launch(File runtime, File node, File server, int port, File home, File data,
                                  File projects, File tmp, File opensslConf, File opensslModules, String appVersion)
            throws IOException {
        ProcessBuilder builder = new ProcessBuilder(node.getAbsolutePath(), server.getAbsolutePath());
        builder.directory(runtime);
        builder.redirectErrorStream(true);
        Map<String, String> env = builder.environment();
        env.put("HOME", home.getAbsolutePath());
        env.put("ORISON_MOBILE_DATA", data.getAbsolutePath());
        env.put("ORISON_PROJECTS_ROOT", projects.getAbsolutePath());
        env.put("ORISON_MOBILE_PORT", String.valueOf(port));
        env.put("ORISON_MOBILE_RENDERER", new File(runtime, "web").getAbsolutePath());
        env.put("TMPDIR", tmp.getAbsolutePath());
        env.put("LD_LIBRARY_PATH", new File(runtime, "lib").getAbsolutePath());
        env.put("NODE_OPTIONS", "--max-old-space-size=768");
        // The Termux node binary hard-codes its OpenSSL directories; point them
        // at the copies extracted next to the runtime.
        env.put("ORISON_APP_VERSION", appVersion);
        env.put("OPENSSL_CONF", opensslConf.getAbsolutePath());
        if (opensslModules.isDirectory()) {
            env.put("OPENSSL_MODULES", opensslModules.getAbsolutePath());
        }
        return builder.start();
    }

    private static String packageVersion(Context context) {
        try {
            return context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0).versionName;
        } catch (Exception err) {
            return "0.3.0-mobile";
        }
    }

    /**
     * Bind-and-release trick: pick a free loopback port so the APK never fights
     * the developer-mode host (or a second app instance) for a fixed port.
     */
    private static int findFreePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            return socket.getLocalPort();
        }
    }

    public static synchronized void stop() {
        if (process != null) {
            try {
                process.destroy();
            } catch (Exception ignored) {}
            process = null;
        }
        if (logPump != null) {
            logPump.interrupt();
            logPump = null;
        }
    }

    public static boolean isRunning() {
        return process != null && process.isAlive();
    }

    /** Tail of the child process log, used for on-screen diagnostics. */
    public static String logTail(int maxLines) {
        if (logFile == null || !logFile.isFile()) return "";
        List<String> lines = new ArrayList<>();
        try (BufferedReader reader = new BufferedReader(new FileReader(logFile))) {
            String line;
            while ((line = reader.readLine()) != null) {
                lines.add(line);
                if (lines.size() > 200) lines.remove(0);
            }
        } catch (IOException err) {
            return "";
        }
        int from = Math.max(0, lines.size() - maxLines);
        StringBuilder out = new StringBuilder();
        for (int i = from; i < lines.size(); i++) {
            out.append(lines.get(i)).append('\n');
        }
        return out.toString();
    }

    private static String describe(Exception err) {
        String tail = logTail(6);
        String message = err.getMessage() == null ? err.toString() : err.getMessage();
        return tail.isEmpty() ? message : (message + "\n" + tail);
    }

    private static void startLogPump() {
        final Process running = process;
        try {
            final OutputStream out = new FileOutputStream(logFile, true);
            logPump = new Thread(new Runnable() {
                @Override public void run() {
                    try (InputStream in = running.getInputStream()) {
                        byte[] buffer = new byte[8192];
                        int read;
                        while ((read = in.read(buffer)) > 0) {
                            out.write(buffer, 0, read);
                            out.flush();
                        }
                    } catch (Exception ignored) {}
                }
            }, "orison-node-log");
            logPump.setDaemon(true);
            logPump.start();
        } catch (IOException err) {
            Log.w(TAG, "cannot open node log: " + err);
        }
    }

    private static void waitForPort(int port, long timeoutMs) throws StartupException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (process != null && !process.isAlive()) {
                throw new StartupException("本地服务进程提前退出\n" + logTail(8));
            }
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress("127.0.0.1", port), 300);
                return;
            } catch (IOException err) {
                try { Thread.sleep(150); } catch (InterruptedException ignored) {}
            }
        }
        throw new StartupException("本地服务启动超时\n" + logTail(8));
    }

    /* ── assets ── */

    private static void extractAssets(AssetManager assets, String assetPath, File destDir) throws IOException {
        String[] children = assets.list(assetPath);
        if (children == null || children.length == 0) {
            copyAssetFile(assets, assetPath, destDir);
            return;
        }
        mkdirs(destDir);
        for (String child : children) {
            String childPath = assetPath + "/" + child;
            File childDest = new File(destDir, child);
            String[] grandChildren = assets.list(childPath);
            if (grandChildren != null && grandChildren.length > 0) {
                mkdirs(childDest);
                extractAssets(assets, childPath, childDest);
            } else {
                copyAssetFile(assets, childPath, childDest);
            }
        }
    }

    private static void copyAssetFile(AssetManager assets, String assetPath, File dest) throws IOException {
        File parent = dest.getParentFile();
        if (parent != null) mkdirs(parent);
        try (InputStream in = assets.open(assetPath); OutputStream out = new FileOutputStream(dest)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
        }
    }

    private static String readText(AssetManager assets, String assetPath) throws IOException {
        try (InputStream in = assets.open(assetPath)) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int read;
            while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
            return new String(out.toByteArray(), "UTF-8");
        }
    }

    private static void setPermissions(File root) {
        File[] files = root.listFiles();
        if (files == null) return;
        for (File file : files) {
            if (file.isDirectory()) {
                file.setExecutable(true, false);
                file.setReadable(true, false);
                setPermissions(file);
            } else {
                file.setReadable(true, false);
                if (file.getName().equals("node")) {
                    file.setExecutable(true, false);
                }
            }
        }
    }

    private static void mkdirs(File dir) {
        if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) {
            Log.w(TAG, "cannot create " + dir);
        }
    }

    private static void deleteRecursive(File file) {
        if (!file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteRecursive(child);
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    private static void writeFile(File file, String content) throws IOException {
        try (FileWriter writer = new FileWriter(file)) {
            writer.write(content);
        }
    }
}
