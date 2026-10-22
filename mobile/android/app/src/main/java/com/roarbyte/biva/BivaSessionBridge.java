package com.roarbyte.biva;

import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.JavascriptInterface;

/** The signed-in account, stored on the phone outside the web page. */
public class BivaSessionBridge {
    private final SharedPreferences prefs;

    public BivaSessionBridge(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences("biva-session", Context.MODE_PRIVATE);
    }

    @JavascriptInterface
    public void saveSession(String session, String path) {
        prefs.edit()
            .putString("session", session == null ? "" : session)
            .putString("path", safePath(path))
            .apply();
    }

    @JavascriptInterface
    public String getSession() {
        return prefs.getString("session", "");
    }

    @JavascriptInterface
    public String getPath() {
        return safePath(prefs.getString("path", ""));
    }

    static String safePath(String path) {
        if (path == null || !path.startsWith("/") || path.startsWith("//") || path.contains("://")) return "";
        return path;
    }
}
