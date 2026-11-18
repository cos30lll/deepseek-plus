package com.deepseek.v2;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.provider.DocumentsContract;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient.FileChooserParams;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/** Uses the system picker, starting in the actual shared-storage Download directory. */
final class DocumentPicker {
    static final int REQUEST = 10;
    private static final long OPEN_TIMEOUT_MS = 12_000;
    private static final Set<String> BACKUP_ACCEPT = new HashSet<>(Arrays.asList(
            ".zip", ".json", "application/zip", "application/x-zip-compressed",
            "application/json", "text/json"));
    private static final String[] BACKUP_MIME_TYPES = {
            "application/zip", "application/x-zip-compressed", "application/x-zip",
            "application/json", "text/json", "text/plain", "application/octet-stream"

    };

    private final Activity activity;
    private final Consumer<String> feedback;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newFixedThreadPool(2);
    private ValueCallback<Uri[]> callback;
    private CancellationSignal probe;
    private Runnable timeout;

    DocumentPicker(Activity activity, Consumer<String> feedback) {
        this.activity = activity;
        this.feedback = feedback;
    }

    private static boolean isBackupPicker(String[] types) {
        if (types == null) return false;
        boolean zip = false;
        boolean json = false;
        for (String group : types) {
            if (group == null) continue;
            for (String raw : group.split(",")) {
                String type = raw.trim().toLowerCase(Locale.ROOT);
                if (type.isEmpty()) continue;
                if (!BACKUP_ACCEPT.contains(type)) return false;
                zip |= type.contains("zip");
                json |= type.contains("json");
            }
        }
        return zip && json;
    }

    void open(ValueCallback<Uri[]> result, FileChooserParams params) {
        if (callback != null) {
            result.onReceiveValue(null);
            return;
        }
        callback = result;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                .setType("*/*")
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE)
                .putExtra(DocumentsContract.EXTRA_INITIAL_URI, DocumentsContract.buildDocumentUri(
                        "com.android.externalstorage.documents", "primary:Download"));
        if (isBackupPicker(params.getAcceptTypes())) {
            intent.putExtra(Intent.EXTRA_MIME_TYPES, BACKUP_MIME_TYPES);
        }
        try {
            activity.startActivityForResult(intent, REQUEST);
        } catch (RuntimeException e) {
            finish(null, "没有可用的文件选择器");
        }
    }

    void onResult(int result, Intent data) {
        if (callback == null) return;
        if (result != Activity.RESULT_OK || data == null) {
            finish(null, null);
            return;
        }
        Set<Uri> uris = new LinkedHashSet<>();
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }
        if (uris.isEmpty()) {
            finish(null, null);
            return;
        }
        CancellationSignal signal = new CancellationSignal();
        probe = signal;
        timeout = () -> {
            if (probe != signal) return;
            finish(null, "打开文件超时，请重新选择本地文件");
            cancelProbe(signal);
        };
        main.postDelayed(timeout, OPEN_TIMEOUT_MS);
        io.execute(() -> checkFiles(uris, signal));
    }

    private void checkFiles(Set<Uri> uris, CancellationSignal signal) {
        List<Uri> readable = new ArrayList<>();
        ContentResolver resolver = activity.getContentResolver();
        for (Uri uri : uris) {
            if (signal.isCanceled()) return;
            if (uri == null || !ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) continue;
            // Some providers list stale rows. Opening a read descriptor catches those before WebView sees them.
            try (AssetFileDescriptor fd = resolver.openAssetFileDescriptor(uri, "r", signal)) {
                if (fd != null) readable.add(uri);
            } catch (java.io.IOException | RuntimeException ignored) {
                if (signal.isCanceled()) return;
            }
        }
        main.post(() -> {
            if (probe != signal) return;
            if (readable.isEmpty()) finish(null, "文件已删除、移动或无法读取，请重新选择");
            else finish(readable.toArray(new Uri[0]), readable.size() == uris.size() ? null : "已跳过无法读取的文件");
        });
    }

    private void finish(Uri[] uris, String message) {
        if (timeout != null) main.removeCallbacks(timeout);
        timeout = null;
        probe = null;
        ValueCallback<Uri[]> selected = callback;
        callback = null;
        if (selected != null) selected.onReceiveValue(uris);
        if (message != null) feedback.accept(message);
    }

    private static void cancelProbe(CancellationSignal signal) {
        new Thread(signal::cancel, "picker-cancel").start();
    }

    void destroy() {
        CancellationSignal signal = probe;
        finish(null, null);
        if (signal != null) cancelProbe(signal);
        io.shutdownNow();
    }
}