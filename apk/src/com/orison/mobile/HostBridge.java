package com.orison.mobile;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import android.webkit.JavascriptInterface;

/**
 * Small JS bridge exposed to the web app as `window.AndroidHost`.
 * Only capabilities the browser cannot provide itself live here.
 */
public class HostBridge {
    private static final String TAG = "OrisonHost";
    private final Activity activity;

    public HostBridge(Activity activity) {
        this.activity = activity;
    }

    /** Open an https URL in the system browser instead of inside the app WebView. */
    @JavascriptInterface
    public void openExternal(String url) {
        try {
            if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) return;
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
        } catch (Exception err) {
            Log.w(TAG, "openExternal failed: " + err);
        }
    }

    @JavascriptInterface
    public String platform() {
        return "android-apk";
    }

    @JavascriptInterface
    public String appVersion() {
        return NodeRuntime.version(activity);
    }
}
