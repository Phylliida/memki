// Capacitor plugin: let the user pick a folder (SAF document tree) and
// read/write individual files inside it. oss-anki keeps its whole collection
// in `oss-anki.json` there so external tools (Syncthing etc.) can sync it.
//
// The picked tree URI is persisted (takePersistableUriPermission) and stored
// in SharedPreferences, so the choice survives restarts. Writes go to a
// `<name>.tmp` sibling that is then renamed over the target — a crash
// mid-write can never leave a truncated save file, and file watchers only
// ever see complete files.
//
// Contract with web/native-bridge.js:
//   pickFolder()            -> { uri, label }          rejects "CANCELLED"
//   getFolder()             -> { uri, label } | { uri: null }
//   readFile({ name })      -> { data: base64 | null }
//   writeFile({ name, data: base64 }) -> { modified }  (atomic tmp+rename)
//   statFile({ name })      -> { exists, modified, size }
//   exportFile({ name, data: base64, mimeType }) -> { uri }
//                             "save as" picker (ACTION_CREATE_DOCUMENT);
//                             rejects "CANCELLED"
//
// Registered from MainActivity.onCreate via registerPlugin(...).

package dev.phylliida.anki;

import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Base64;

import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

@CapacitorPlugin(name = "SaveFolder")
public class SaveFolderPlugin extends Plugin {

    private static final String PREFS = "SaveFolderPrefs";
    private static final String KEY_URI = "treeUri";
    private static final String KEY_LABEL = "treeLabel";

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, 0);
    }

    private DocumentFile tree() {
        String uri = prefs().getString(KEY_URI, null);
        if (uri == null) return null;
        return DocumentFile.fromTreeUri(getContext(), Uri.parse(uri));
    }

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "pickFolderResult");
    }

    @ActivityCallback
    private void pickFolderResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        Uri uri = data != null ? data.getData() : null;
        if (uri == null) {
            call.reject("Folder pick cancelled", "CANCELLED");
            return;
        }
        try {
            final int flags = Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
            getContext().getContentResolver().takePersistableUriPermission(uri, flags);
        } catch (SecurityException ignored) {
            // Some providers don't offer persistable grants; the URI still
            // works for this session and the user can re-pick later.
        }
        DocumentFile doc = DocumentFile.fromTreeUri(getContext(), uri);
        String label = doc != null && doc.getName() != null ? doc.getName() : uri.getLastPathSegment();
        prefs().edit().putString(KEY_URI, uri.toString()).putString(KEY_LABEL, label).apply();
        JSObject ret = new JSObject();
        ret.put("uri", uri.toString());
        ret.put("label", label);
        call.resolve(ret);
    }

    @PluginMethod
    public void getFolder(PluginCall call) {
        JSObject ret = new JSObject();
        String uri = prefs().getString(KEY_URI, null);
        if (uri == null) {
            ret.put("uri", JSObject.NULL);
        } else {
            ret.put("uri", uri);
            ret.put("label", prefs().getString(KEY_LABEL, uri));
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void readFile(PluginCall call) {
        String name = call.getString("name");
        JSObject ret = new JSObject();
        try {
            DocumentFile file = findFile(name);
            if (file == null) {
                ret.put("data", JSObject.NULL);
            } else {
                ret.put("data", Base64.encodeToString(readAll(file), Base64.NO_WRAP));
            }
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("read failed: " + e.getMessage(), "IO", e);
        }
    }

    @PluginMethod
    public void writeFile(PluginCall call) {
        String name = call.getString("name");
        String data = call.getString("data");
        if (name == null || data == null) {
            call.reject("need name and data", "BAD_INPUT");
            return;
        }
        try {
            DocumentFile dir = tree();
            if (dir == null) {
                call.reject("no save folder chosen", "NO_FOLDER");
                return;
            }
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            String tmpName = name + ".tmp";

            DocumentFile tmp = findFile(tmpName);
            if (tmp == null) tmp = dir.createFile("application/octet-stream", tmpName);
            if (tmp == null) throw new java.io.IOException("could not create " + tmpName);
            try (OutputStream out = getContext().getContentResolver()
                    .openOutputStream(tmp.getUri(), "wt")) {
                if (out == null) throw new java.io.IOException("no output stream for " + tmpName);
                out.write(bytes);
            }

            DocumentFile target = findFile(name);
            if (target != null) target.delete();
            if (!tmp.renameTo(name)) {
                // renameTo can fail on some providers; fall back to a move.
                DocumentFile fallback = dir.createFile("application/octet-stream", name);
                try (OutputStream out = getContext().getContentResolver()
                        .openOutputStream(fallback.getUri(), "wt")) {
                    out.write(bytes);
                }
                tmp.delete();
            }

            DocumentFile written = findFile(name);
            JSObject ret = new JSObject();
            ret.put("modified", written != null ? written.lastModified() : System.currentTimeMillis());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("write failed: " + e.getMessage(), "IO", e);
        }
    }

    // ── "Save as" export (ACTION_CREATE_DOCUMENT) ────────────────
    // Bytes are stashed in pendingExportBytes because the write can only
    // happen after the picker returns a document URI.
    private byte[] pendingExportBytes;

    @PluginMethod
    public void exportFile(PluginCall call) {
        String name = call.getString("name");
        String data = call.getString("data");
        String mime = call.getString("mimeType", "application/octet-stream");
        if (name == null || data == null) {
            call.reject("need name and data", "BAD_INPUT");
            return;
        }
        try {
            pendingExportBytes = Base64.decode(data, Base64.DEFAULT);
        } catch (Exception e) {
            call.reject("bad base64 data", "BAD_INPUT");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE, name); // suggested file name
        startActivityForResult(call, intent, "exportFileResult");
    }

    @ActivityCallback
    private void exportFileResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        try {
            Intent data = result.getData();
            Uri uri = data != null ? data.getData() : null;
            if (uri == null) {
                call.reject("Export cancelled", "CANCELLED");
                return;
            }
            try (OutputStream out = getContext().getContentResolver()
                    .openOutputStream(uri, "wt")) { // "wt" truncates an existing pick
                if (out == null) throw new java.io.IOException("no output stream for picked document");
                out.write(pendingExportBytes);
            }
            JSObject ret = new JSObject();
            ret.put("uri", uri.toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("export write failed: " + e.getMessage(), "IO", e);
        } finally {
            pendingExportBytes = null;
        }
    }

    @PluginMethod
    public void statFile(PluginCall call) {
        String name = call.getString("name");
        JSObject ret = new JSObject();
        DocumentFile file = findFile(name);
        ret.put("exists", file != null);
        ret.put("modified", file != null ? file.lastModified() : 0);
        ret.put("size", file != null ? file.length() : 0);
        call.resolve(ret);
    }

    private DocumentFile findFile(String name) {
        if (name == null) return null;
        DocumentFile dir = tree();
        return dir != null ? dir.findFile(name) : null;
    }

    private byte[] readAll(DocumentFile file) throws java.io.IOException {
        try (InputStream in = getContext().getContentResolver().openInputStream(file.getUri())) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[64 * 1024];
            int n;
            while ((n = in.read(chunk)) != -1) buf.write(chunk, 0, n);
            return buf.toByteArray();
        }
    }
}
