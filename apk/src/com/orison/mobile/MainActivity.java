package com.orison.mobile;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Single-activity shell: starts the bundled Node host, then renders the real
 * Orison Space UI (the same React app the desktop Electron build uses) in a
 * WebView pointed at http://127.0.0.1:3210/.
 */
public class MainActivity extends Activity {
    private static final String TAG = "OrisonMain";
    private static final int BG = 0xFF12100E;

    private WebView webView;
    private View splash;
    private TextView statusText;
    private boolean loaded = false;
    private final Handler handler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        WebView.setWebContentsDebuggingEnabled(true);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG);

        webView = new WebView(this);
        webView.setBackgroundColor(BG);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                loaded = true;
                fadeOutSplash();
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                if (!loaded) showError("界面加载失败 (" + errorCode + ")\n" + description);
            }
        });
        webView.addJavascriptInterface(new HostBridge(this), "AndroidHost");

        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        splash = buildSplash();
        root.addView(splash, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
        startHost();
    }

    private View buildSplash() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(BG);
        box.setPadding(dp(32), dp(32), dp(32), dp(32));

        TextView brand = new TextView(this);
        brand.setText("Orison Space");
        brand.setTextColor(0xFFF2E9DF);
        brand.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30);
        brand.setTypeface(Typeface.create("serif", Typeface.BOLD));
        brand.setGravity(Gravity.CENTER);

        TextView subtitle = new TextView(this);
        subtitle.setText("AI 小说创作工作台 · 手机版");
        subtitle.setTextColor(0xFF9A8F84);
        subtitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        subtitle.setGravity(Gravity.CENTER);
        subtitle.setPadding(0, dp(10), 0, dp(28));

        ProgressBar bar = new ProgressBar(this);
        bar.setIndeterminate(true);

        statusText = new TextView(this);
        statusText.setText("正在启动本地服务…");
        statusText.setTextColor(0xFF9A8F84);
        statusText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        statusText.setGravity(Gravity.CENTER);
        statusText.setPadding(0, dp(22), 0, 0);

        box.addView(brand);
        box.addView(subtitle);
        box.addView(bar);
        box.addView(statusText);
        return box;
    }

    private void startHost() {
        if (NodeRuntime.needsExtraction(this)) {
            statusText.setText("首次启动，正在解包内置运行时（约 117 MB）…");
        }
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    final int port = NodeRuntime.start(getApplicationContext());
                    handler.post(new Runnable() {
                        @Override public void run() {
                            statusText.setText("正在载入工作台…");
                            webView.loadUrl("http://127.0.0.1:" + port + "/");
                        }
                    });
                } catch (final NodeRuntime.StartupException err) {
                    Log.e(TAG, "host failed", err);
                    handler.post(new Runnable() {
                        @Override public void run() {
                            showError("本地服务启动失败\n\n" + err.getMessage());
                        }
                    });
                }
            }
        }, "orison-host-start").start();
    }

    private void fadeOutSplash() {
        if (splash == null) return;
        splash.animate().alpha(0f).setDuration(220).withEndAction(new Runnable() {
            @Override public void run() {
                if (splash != null) splash.setVisibility(View.GONE);
            }
        });
    }

    private void showError(String rawMessage) {
        // Keep the splash readable: long Node stack traces are selectable text.
        String message = rawMessage;
        if (message.length() > 1600) message = message.substring(0, 1600) + "…";
        if (statusText != null) {
            statusText.setTextIsSelectable(true);
            statusText.setTextColor(0xFFFF7A7A);
            statusText.setText(message);
        }
        Toast.makeText(this, "Orison 启动失败，可在日志中查看详情", Toast.LENGTH_LONG).show();
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (isFinishing()) {
            NodeRuntime.stop();
        }
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
