package com.threadbrief.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "ThreadBriefNative")
public class ThreadBriefNativePlugin extends Plugin {
    private static final String PREFS_NAME = "threadbrief_settings";
    private static final String API_KEY_CIPHERTEXT = "api_key_ciphertext";
    private static final String API_KEY_IV = "api_key_iv";
    private static final String WEBDAV_SERVER_URL = "webdav_server_url";
    private static final String WEBDAV_REMOTE_PATH = "webdav_remote_path";
    private static final String WEBDAV_USERNAME = "webdav_username";
    private static final String WEBDAV_PASSWORD_CIPHERTEXT = "webdav_password_ciphertext";
    private static final String WEBDAV_PASSWORD_IV = "webdav_password_iv";
    private static final String BASE_URL = "base_url";
    private static final String MODEL = "model";
    private static final String KEY_ALIAS = "threadbrief_api_key";
    private static final String WEBDAV_KEY_ALIAS = "threadbrief_webdav";
    private static final String KEYSTORE_NAME = "AndroidKeyStore";
    private static final String DEFAULT_BASE_URL = "https://api.openai.com/v1";
    private static final String DEFAULT_MODEL = "gpt-5-mini";
    private static final String DEFAULT_WEBDAV_PATH = "threadbrief/history.json";
    private static final int REQUEST_TIMEOUT_MS = 15_000;
    private static final int OPENAI_TIMEOUT_MS = 60_000;
    private static final int WEBDAV_TIMEOUT_MS = 30_000;
    private static final int MAX_HTML_BYTES = 10 * 1024 * 1024;
    private static final int MAX_JSON_BYTES = 2 * 1024 * 1024;
    private static final int MAX_WEBDAV_BYTES = 20 * 1024 * 1024;

    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final ConcurrentHashMap<String, Future<?>> tasks = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, HttpURLConnection> connections = new ConcurrentHashMap<>();

    private interface RequestWork {
        JSObject run() throws Exception;
    }

    private static final class NativeRequestException extends Exception {
        private final String code;

        private NativeRequestException(String message, String code) {
            super(message);
            this.code = code;
        }
    }

    @PluginMethod
    public void requestHtml(PluginCall call) {
        String url = call.getString("url");
        String requestId = requestId(call);
        if (url == null || url.trim().isEmpty()) {
            call.reject("缺少 Telegram 页面地址。", "INVALID_URL");
            return;
        }
        submit(requestId, call, () -> requestHtml(url, requestId));
    }

    @PluginMethod
    public void chatJson(PluginCall call) {
        String requestId = requestId(call);
        submit(requestId, call, () -> requestChatJson(call, requestId));
    }

    @PluginMethod
    public void getSettings(PluginCall call) {
        try {
            SharedPreferences preferences = preferences();
            JSObject result = new JSObject();
            result.put("hasApiKey", hasApiKey());
            result.put("baseUrl", preferences.getString(BASE_URL, DEFAULT_BASE_URL));
            result.put("model", preferences.getString(MODEL, DEFAULT_MODEL));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("无法读取本地配置。", "SETTINGS_READ_FAILED");
        }
    }

    @PluginMethod
    public void saveSettings(PluginCall call) {
        try {
            String baseUrl = normalizeBaseUrl(call.getString("baseUrl"));
            String model = call.getString("model");
            if (model == null || model.trim().isEmpty()) throw new NativeRequestException("请输入模型名称。", "INVALID_SETTINGS");

            String apiKey = call.getString("apiKey");
            SharedPreferences.Editor editor = preferences().edit()
                    .putString(BASE_URL, baseUrl)
                    .putString(MODEL, model.trim());
            if (apiKey != null && !apiKey.trim().isEmpty()) {
                encryptApiKey(apiKey.trim(), editor);
            }
            if (!editor.commit()) throw new NativeRequestException("无法保存本地配置。", "SETTINGS_WRITE_FAILED");
            call.resolve();
        } catch (NativeRequestException error) {
            call.reject(error.getMessage(), error.code);
        } catch (Exception error) {
            call.reject("无法保存本地配置。", "SETTINGS_WRITE_FAILED");
        }
    }

    @PluginMethod
    public void clearSettings(PluginCall call) {
        try {
            SharedPreferences.Editor editor = preferences().edit()
                    .remove(API_KEY_CIPHERTEXT)
                    .remove(API_KEY_IV);
            if (!editor.commit()) throw new NativeRequestException("无法清除本地 API Key。", "SETTINGS_WRITE_FAILED");
            deleteKeyAlias();
            call.resolve();
        } catch (NativeRequestException error) {
            call.reject(error.getMessage(), error.code);
        } catch (Exception error) {
            call.reject("无法清除本地 API Key。", "SETTINGS_WRITE_FAILED");
        }
    }

    @PluginMethod
    public void getWebDavSettings(PluginCall call) {
        try {
            SharedPreferences preferences = preferences();
            JSObject result = new JSObject();
            result.put("serverUrl", preferences.getString(WEBDAV_SERVER_URL, ""));
            result.put("remotePath", preferences.getString(WEBDAV_REMOTE_PATH, DEFAULT_WEBDAV_PATH));
            result.put("username", preferences.getString(WEBDAV_USERNAME, ""));
            result.put("hasPassword", hasWebDavPassword());
            call.resolve(result);
        } catch (Exception error) {
            call.reject("无法读取 WebDAV 配置。", "WEBDAV_SETTINGS_READ_FAILED");
        }
    }

    @PluginMethod
    public void saveWebDavSettings(PluginCall call) {
        try {
            String serverUrl = normalizeWebDavUrl(call.getString("serverUrl"));
            String remotePath = normalizeWebDavPath(call.getString("remotePath"));
            String username = call.getString("username");
            if (username == null || username.trim().isEmpty()) throw new NativeRequestException("请输入 WebDAV 用户名。", "WEBDAV_INVALID_SETTINGS");
            String password = call.getString("password");
            SharedPreferences.Editor editor = preferences().edit()
                    .putString(WEBDAV_SERVER_URL, serverUrl)
                    .putString(WEBDAV_REMOTE_PATH, remotePath)
                    .putString(WEBDAV_USERNAME, username.trim());
            if (password != null && !password.trim().isEmpty()) {
                encryptWebDavPassword(password.trim(), editor);
            } else if (!hasWebDavPassword()) {
                throw new NativeRequestException("请输入 WebDAV 密码。", "WEBDAV_INVALID_SETTINGS");
            }
            if (!editor.commit()) throw new NativeRequestException("无法保存 WebDAV 配置。", "WEBDAV_SETTINGS_WRITE_FAILED");
            call.resolve();
        } catch (NativeRequestException error) {
            call.reject(error.getMessage(), error.code);
        } catch (Exception error) {
            call.reject("无法保存 WebDAV 配置。", "WEBDAV_SETTINGS_WRITE_FAILED");
        }
    }

    @PluginMethod
    public void clearWebDavSettings(PluginCall call) {
        try {
            SharedPreferences.Editor editor = preferences().edit()
                    .remove(WEBDAV_SERVER_URL)
                    .remove(WEBDAV_REMOTE_PATH)
                    .remove(WEBDAV_USERNAME)
                    .remove(WEBDAV_PASSWORD_CIPHERTEXT)
                    .remove(WEBDAV_PASSWORD_IV);
            if (!editor.commit()) throw new NativeRequestException("无法清除 WebDAV 配置。", "WEBDAV_SETTINGS_WRITE_FAILED");
            deleteKeyAlias(WEBDAV_KEY_ALIAS);
            call.resolve();
        } catch (NativeRequestException error) {
            call.reject(error.getMessage(), error.code);
        } catch (Exception error) {
            call.reject("无法清除 WebDAV 配置。", "WEBDAV_SETTINGS_WRITE_FAILED");
        }
    }

    @PluginMethod
    public void requestWebDav(PluginCall call) {
        String requestId = requestId(call);
        submit(requestId, call, () -> requestWebDav(call, requestId));
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String requestId = call.getString("requestId");
        if (requestId != null) {
            HttpURLConnection connection = connections.remove(requestId);
            if (connection != null) connection.disconnect();
            Future<?> task = tasks.remove(requestId);
            if (task != null) task.cancel(true);
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (HttpURLConnection connection : connections.values()) connection.disconnect();
        for (Future<?> task : tasks.values()) task.cancel(true);
        executor.shutdownNow();
        super.handleOnDestroy();
    }

    private void submit(String requestId, PluginCall call, RequestWork work) {
        Future<?> task = executor.submit(() -> {
            try {
                call.resolve(work.run());
            } catch (NativeRequestException error) {
                call.reject(error.getMessage(), error.code);
            } catch (java.net.SocketTimeoutException error) {
                call.reject("网络请求超时，请稍后重试。", "REQUEST_TIMEOUT");
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                call.reject("请求已取消。", "REQUEST_CANCELLED");
            } catch (Exception error) {
                call.reject(error.getMessage() == null ? "网络请求失败，请检查网络连接。" : error.getMessage(), "REQUEST_FAILED");
            } finally {
                connections.remove(requestId);
                tasks.remove(requestId);
            }
        });
        tasks.put(requestId, task);
    }

    private JSObject requestHtml(String urlValue, String requestId) throws Exception {
        URL url = validateHttpsUrl(urlValue);
        HttpURLConnection connection = openConnection(url, requestId, REQUEST_TIMEOUT_MS);
        try {
            connection.setRequestProperty("Accept", "text/html,application/xhtml+xml");
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setRequestProperty("User-Agent", "ThreadBrief/0.1 (+Android public page reader)");
            int status = connection.getResponseCode();
            InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String body = input == null ? "" : readBody(input, MAX_HTML_BYTES);
            JSObject result = new JSObject();
            result.put("status", status);
            result.put("body", body);
            return result;
        } finally {
            connection.disconnect();
            connections.remove(requestId);
        }
    }

    private JSObject requestWebDav(PluginCall call, String requestId) throws Exception {
        JSONObject input = call.getData();
        if (input == null) throw new NativeRequestException("WebDAV 请求参数无效。", "WEBDAV_INVALID_SETTINGS");
        String method = input.optString("method", "").toUpperCase(Locale.ROOT);
        if (!"GET".equals(method) && !"PUT".equals(method)) throw new NativeRequestException("WebDAV 请求方法无效。", "WEBDAV_INVALID_SETTINGS");
        SharedPreferences preferences = preferences();
        String serverUrl = normalizeWebDavUrl(preferences.getString(WEBDAV_SERVER_URL, ""));
        String remotePath = normalizeWebDavPath(preferences.getString(WEBDAV_REMOTE_PATH, DEFAULT_WEBDAV_PATH));
        String username = preferences.getString(WEBDAV_USERNAME, "");
        String password = readWebDavPassword();
        String body = input.optString("body", null);
        if ("PUT".equals(method) && (body == null || body.getBytes(StandardCharsets.UTF_8).length > MAX_WEBDAV_BYTES)) throw new NativeRequestException("WebDAV 历史文件过大。", "WEBDAV_RESPONSE_TOO_LARGE");

        URL url = buildWebDavUrl(serverUrl, remotePath);
        HttpURLConnection connection = openConnection(url, requestId, WEBDAV_TIMEOUT_MS);
        try {
            connection.setRequestMethod(method);
            connection.setRequestProperty("Accept", "application/json, text/plain, */*");
            connection.setRequestProperty("Authorization", "Basic " + Base64.encodeToString((username.trim() + ":" + password).getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
            if ("PUT".equals(method)) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(body.getBytes(StandardCharsets.UTF_8));
                }
            }
            int status = connection.getResponseCode();
            InputStream inputStream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String responseBody = inputStream == null ? "" : readBody(inputStream, MAX_WEBDAV_BYTES);
            JSObject result = new JSObject();
            result.put("status", status);
            result.put("body", responseBody);
            return result;
        } finally {
            connection.disconnect();
            connections.remove(requestId);
        }
    }

    private JSObject requestChatJson(PluginCall call, String requestId) throws Exception {
        JSONObject input = call.getData();
        if (input == null) throw new NativeRequestException("请求参数无效。", "INVALID_JSON");
        String baseUrl = normalizeBaseUrl(input.optString("baseUrl", ""));
        String model = input.optString("model", "").trim();
        JSONArray messages = input.optJSONArray("messages");
        JSONObject responseFormat = input.optJSONObject("responseFormat");
        if (model.isEmpty() || messages == null || responseFormat == null) {
            throw new NativeRequestException("总结请求参数无效。", "INVALID_JSON");
        }

        String apiKey = readApiKey();
        URL url = validateHttpsUrl(baseUrl + "/chat/completions");
        HttpURLConnection connection = openConnection(url, requestId, OPENAI_TIMEOUT_MS);
        try {
            connection.setDoOutput(true);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Authorization", "Bearer " + apiKey);

            JSONObject payload = new JSONObject();
            payload.put("model", model);
            payload.put("messages", messages);
            payload.put("response_format", responseFormat);
            byte[] requestBody = payload.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(requestBody);
            }

            int status = connection.getResponseCode();
            InputStream inputStream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String body = inputStream == null ? "" : readBody(inputStream, MAX_JSON_BYTES);
            if (status < 200 || status >= 300) throw openAIError(status, body);

            try {
                JSONObject response = new JSONObject(body);
                JSONArray choices = response.getJSONArray("choices");
                JSONObject message = choices.getJSONObject(0).getJSONObject("message");
                String content = message.optString("content", "");
                if (content.isEmpty()) throw new NativeRequestException("模型返回内容为空。", "OPENAI_INVALID_RESPONSE");
                JSObject result = new JSObject();
                result.put("content", content);
                return result;
            } catch (JSONException error) {
                throw new NativeRequestException("模型返回格式异常，请重试。", "OPENAI_INVALID_RESPONSE");
            }
        } finally {
            connection.disconnect();
            connections.remove(requestId);
        }
    }

    private NativeRequestException openAIError(int status, String body) {
        String details = body == null ? "" : body.toLowerCase(Locale.ROOT);
        if (status == 401) return new NativeRequestException("OpenAI API Key 无效或已过期。", "OPENAI_AUTH_FAILED");
        if (status == 403) return new NativeRequestException("OpenAI Key 没有访问该模型或接口的权限。", "OPENAI_PERMISSION_DENIED");
        if (status == 429) {
            String code = details.matches(".*(insufficient[_ -]?quota|quota|billing|余额|配额).*") ? "OPENAI_INSUFFICIENT_QUOTA" : "OPENAI_RATE_LIMITED";
            String message = "OPENAI_INSUFFICIENT_QUOTA".equals(code) ? "OpenAI 账户余额或配额不足。" : "OpenAI 请求过于频繁，请稍后重试。";
            return new NativeRequestException(message, code);
        }
        if (status == 404 || details.matches(".*(model[_ -]?not[_ -]?found|model does not exist).*") ) {
            return new NativeRequestException("模型不存在或当前接口不支持该模型。", "OPENAI_MODEL_NOT_FOUND");
        }
        if (details.matches(".*(response[_ -]?format|json[_ -]?schema|structured output|structured outputs|not supported).*") ) {
            return new NativeRequestException("当前模型或中转站不支持结构化 JSON 输出。", "OPENAI_STRUCTURED_OUTPUT_UNSUPPORTED");
        }
        return new NativeRequestException("OpenAI 请求失败，请检查接口地址和网络。", "OPENAI_REQUEST_FAILED");
    }

    private HttpURLConnection openConnection(URL url, String requestId, int timeoutMs) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(timeoutMs);
        connection.setReadTimeout(timeoutMs);
        connection.setInstanceFollowRedirects(true);
        connections.put(requestId, connection);
        return connection;
    }

    private String readBody(InputStream input, int maxBytes) throws IOException, NativeRequestException {
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int total = 0;
            int read;
            while ((read = stream.read(buffer)) != -1) {
                total += read;
                if (total > maxBytes) throw new NativeRequestException("响应内容过大。", "RESPONSE_TOO_LARGE");
                output.write(buffer, 0, read);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private URL validateHttpsUrl(String value) throws Exception {
        URI uri = URI.create(value);
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null) {
            throw new NativeRequestException("只支持 HTTPS 地址。", "INVALID_URL");
        }
        return uri.toURL();
    }

    private URL validateHttpUrl(String value) throws Exception {
        URI uri = URI.create(value);
        if (!("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme())) || uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null) {
            throw new NativeRequestException("WebDAV 地址必须是有效的 HTTP 或 HTTPS 地址。", "WEBDAV_INVALID_SETTINGS");
        }
        return uri.toURL();
    }

    private String normalizeBaseUrl(String value) throws Exception {
        if (value == null || value.trim().isEmpty()) value = DEFAULT_BASE_URL;
        String normalized = value.trim().replaceAll("/+$", "");
        validateHttpsUrl(normalized);
        return normalized;
    }

    private String normalizeWebDavUrl(String value) throws Exception {
        if (value == null || value.trim().isEmpty()) throw new NativeRequestException("请输入 WebDAV 地址。", "WEBDAV_INVALID_SETTINGS");
        String normalized = value.trim().replaceAll("/+$", "");
        validateHttpUrl(normalized);
        return normalized;
    }

    private String normalizeWebDavPath(String value) throws NativeRequestException {
        String normalized = (value == null || value.trim().isEmpty() ? DEFAULT_WEBDAV_PATH : value.trim()).replaceAll("^/+", "");
        String[] segments = normalized.split("/", -1);
        if (normalized.isEmpty() || normalized.contains("?") || normalized.contains("#")) throw new NativeRequestException("WebDAV 远程路径无效。", "WEBDAV_INVALID_SETTINGS");
        for (String segment : segments) {
            if (segment.isEmpty() || ".".equals(segment) || "..".equals(segment)) throw new NativeRequestException("WebDAV 远程路径无效。", "WEBDAV_INVALID_SETTINGS");
        }
        return normalized;
    }

    private URL buildWebDavUrl(String serverUrl, String remotePath) throws Exception {
        return validateHttpUrl(serverUrl + "/" + remotePath);
    }

    private SharedPreferences preferences() {
        Context context = getContext();
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private boolean hasApiKey() {
        SharedPreferences preferences = preferences();
        return preferences.contains(API_KEY_CIPHERTEXT) && preferences.contains(API_KEY_IV);
    }

    private boolean hasWebDavPassword() {
        SharedPreferences preferences = preferences();
        return preferences.contains(WEBDAV_PASSWORD_CIPHERTEXT) && preferences.contains(WEBDAV_PASSWORD_IV);
    }

    private String readApiKey() throws Exception {
        SharedPreferences preferences = preferences();
        String encodedCiphertext = preferences.getString(API_KEY_CIPHERTEXT, null);
        String encodedIv = preferences.getString(API_KEY_IV, null);
        if (encodedCiphertext == null || encodedIv == null) {
            throw new NativeRequestException("请先在设置中保存 OpenAI API Key。", "ANDROID_API_KEY_MISSING");
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, getSecretKey(), new GCMParameterSpec(128, Base64.decode(encodedIv, Base64.NO_WRAP)));
            return new String(cipher.doFinal(Base64.decode(encodedCiphertext, Base64.NO_WRAP)), StandardCharsets.UTF_8);
        } catch (GeneralSecurityException error) {
            throw new NativeRequestException("本地 API Key 无法解密，请重新保存。", "ANDROID_API_KEY_INVALID");
        }
    }

    private void encryptApiKey(String apiKey, SharedPreferences.Editor editor) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getSecretKey(KEY_ALIAS));
        byte[] ciphertext = cipher.doFinal(apiKey.getBytes(StandardCharsets.UTF_8));
        editor.putString(API_KEY_CIPHERTEXT, Base64.encodeToString(ciphertext, Base64.NO_WRAP));
        editor.putString(API_KEY_IV, Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP));
    }

    private String readWebDavPassword() throws Exception {
        SharedPreferences preferences = preferences();
        String encodedCiphertext = preferences.getString(WEBDAV_PASSWORD_CIPHERTEXT, null);
        String encodedIv = preferences.getString(WEBDAV_PASSWORD_IV, null);
        if (encodedCiphertext == null || encodedIv == null) throw new NativeRequestException("请先配置 WebDAV 密码。", "WEBDAV_NOT_CONFIGURED");
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, getSecretKey(WEBDAV_KEY_ALIAS), new GCMParameterSpec(128, Base64.decode(encodedIv, Base64.NO_WRAP)));
            return new String(cipher.doFinal(Base64.decode(encodedCiphertext, Base64.NO_WRAP)), StandardCharsets.UTF_8);
        } catch (GeneralSecurityException error) {
            throw new NativeRequestException("WebDAV 密码无法解密，请重新保存。", "WEBDAV_PASSWORD_INVALID");
        }
    }

    private void encryptWebDavPassword(String password, SharedPreferences.Editor editor) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getSecretKey(WEBDAV_KEY_ALIAS));
        byte[] ciphertext = cipher.doFinal(password.getBytes(StandardCharsets.UTF_8));
        editor.putString(WEBDAV_PASSWORD_CIPHERTEXT, Base64.encodeToString(ciphertext, Base64.NO_WRAP));
        editor.putString(WEBDAV_PASSWORD_IV, Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP));
    }

    private SecretKey getSecretKey() throws GeneralSecurityException {
        return getSecretKey(KEY_ALIAS);
    }

    private SecretKey getSecretKey(String alias) throws GeneralSecurityException {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE_NAME);
        try {
            keyStore.load(null);
        } catch (Exception error) {
            throw new GeneralSecurityException(error);
        }
        if (keyStore.containsAlias(alias)) {
            return ((KeyStore.SecretKeyEntry) keyStore.getEntry(alias, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_NAME);
        generator.init(new KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }

    private void deleteKeyAlias() throws GeneralSecurityException {
        deleteKeyAlias(KEY_ALIAS);
    }

    private void deleteKeyAlias(String alias) throws GeneralSecurityException {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE_NAME);
        try {
            keyStore.load(null);
        } catch (Exception error) {
            throw new GeneralSecurityException(error);
        }
        if (keyStore.containsAlias(alias)) keyStore.deleteEntry(alias);
    }

    private String requestId(PluginCall call) {
        String value = call.getString("requestId");
        return value == null || value.trim().isEmpty() ? UUID.randomUUID().toString() : value;
    }
}
