package com.datacore.nibrasgpt;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.Message;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.Toast;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {
    private static final String HOME = "https://rahmankhanrm1-cloud.github.io/datacore-ai/";
    private static final int FILE_REQUEST = 4370;
    private WebView webView;
    private ProgressBar loading;
    private ValueCallback<Uri[]> upload;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(10,16,35));
        getWindow().setNavigationBarColor(Color.rgb(10,16,35));

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(10,16,35));
        loading = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        loading.setMax(100);
        loading.setLayoutParams(new LinearLayout.LayoutParams(-1, 3));
        root.addView(loading);

        webView = new WebView(this);
        webView.setLayoutParams(new LinearLayout.LayoutParams(-1, 0, 1));
        root.addView(webView);
        setContentView(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            settings.setSafeBrowsingEnabled(true);
        }
        CookieManager.getInstance().setAcceptCookie(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request.isForMainFrame() && !isTrusted(request.getUrl())) {
                    openOutside(request.getUrl());
                    return true;
                }
                return false;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                Uri uri = Uri.parse(url);
                if (!isTrusted(uri)) { openOutside(uri); return true; }
                return false;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int progress) {
                loading.setProgress(progress);
                loading.setVisibility(progress >= 100 ? View.GONE : View.VISIBLE);
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                if (upload != null) upload.onReceiveValue(null);
                upload = callback;
                try {
                    Intent intent = params.createIntent();
                    startActivityForResult(intent, FILE_REQUEST);
                    return true;
                } catch (ActivityNotFoundException e) {
                    upload = null;
                    Toast.makeText(MainActivity.this, "No file picker found", Toast.LENGTH_SHORT).show();
                    return false;
                }
            }
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean userGesture,
                    Message resultMsg) {
                if (!userGesture) return false;
                WebView popup = new WebView(MainActivity.this);
                popup.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        openOutside(request.getUrl());
                        return true;
                    }
                    @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap favicon) {
                        if (url != null && !url.equals("about:blank")) {
                            openOutside(Uri.parse(url));
                            v.stopLoading();
                        }
                    }
                });
                WebView.WebViewTransport t = (WebView.WebViewTransport)resultMsg.obj;
                t.setWebView(popup);
                resultMsg.sendToTarget();
                return true;
            }
        });

        webView.setDownloadListener(new DownloadListener() {
            @Override public void onDownloadStart(String url, String ua,
                    String disposition, String mime, long length) {
                try {
                    Uri uri = Uri.parse(url);
                    if (!"https".equalsIgnoreCase(uri.getScheme())) {
                        Toast.makeText(MainActivity.this, "Use the browser to download this file", Toast.LENGTH_LONG).show();
                        return;
                    }
                    DownloadManager.Request req = new DownloadManager.Request(uri);
                    req.setMimeType(mime);
                    req.addRequestHeader("User-Agent", ua);
                    req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    String name = android.webkit.URLUtil.guessFileName(url, disposition, mime);
                    req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                    ((DownloadManager)getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(req);
                    Toast.makeText(MainActivity.this, "Downloading to Downloads", Toast.LENGTH_SHORT).show();
                } catch (Exception ex) {
                    openOutside(Uri.parse(url));
                }
            }
        });

        if (state == null) webView.loadUrl(HOME);
        else webView.restoreState(state);
    }

    private boolean isTrusted(Uri uri) {
        if (!"https".equalsIgnoreCase(uri.getScheme())) return false;
        if (!"rahmankhanrm1-cloud.github.io".equalsIgnoreCase(uri.getHost())) return false;
        String path = uri.getPath();
        return path != null && (path.equals("/datacore-ai") || path.startsWith("/datacore-ai/"));
    }

    private void openOutside(Uri uri) {
        try {
            if ("https".equalsIgnoreCase(uri.getScheme()) || "http".equalsIgnoreCase(uri.getScheme())) {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            }
        } catch (Exception e) {
            Toast.makeText(this, "Unable to open link", Toast.LENGTH_SHORT).show();
        }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == FILE_REQUEST && upload != null) {
            upload.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            upload = null;
        }
    }

    @Override public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        if (webView != null) webView.saveState(state);
        super.onSaveInstanceState(state);
    }

    @Override protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
