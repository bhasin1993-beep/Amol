package com.paisa.app;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.Telephony;
import android.telephony.SmsMessage;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import java.util.HashMap;
import java.util.Map;

/**
 * SmsReader — reads bank / UPI / credit-card transaction SMS so Paisa can
 * auto-log expenses. Everything stays on the device; nothing is sent anywhere.
 *
 *  JS API (window.Capacitor.Plugins.SmsReader):
 *    requestPermissions()            -> { sms: "granted" | "denied" | "prompt" }
 *    readInbox({ since, max })       -> { messages: [{ address, body, date }] }
 *    startWatch()                    -> registers a live SMS_RECEIVED listener
 *    stopWatch()
 *    addListener("smsReceived", cb)  -> cb({ address, body, date })
 */
@CapacitorPlugin(
    name = "SmsReader",
    permissions = {
        @Permission(alias = "sms", strings = { Manifest.permission.READ_SMS, Manifest.permission.RECEIVE_SMS })
    }
)
public class SmsReaderPlugin extends Plugin {

    private BroadcastReceiver receiver;

    private boolean hasReadSms() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.READ_SMS)
            == PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod
    public void readInbox(PluginCall call) {
        if (!hasReadSms()) {
            JSObject ret = new JSObject();
            ret.put("messages", new JSArray());
            ret.put("denied", true);
            call.resolve(ret);
            return;
        }

        Long sinceL = call.getLong("since");
        long since = sinceL != null ? sinceL : 0L;
        Integer maxI = call.getInt("max", 500);
        int max = maxI != null ? maxI : 500;

        JSArray messages = new JSArray();
        Cursor c = null;
        try {
            Uri uri = Uri.parse("content://sms/inbox");
            String[] cols = new String[] { "address", "body", "date" };
            String sel = since > 0 ? "date>=?" : null;
            String[] args = since > 0 ? new String[] { String.valueOf(since) } : null;
            c = getContext().getContentResolver().query(uri, cols, sel, args, "date DESC");
            int n = 0;
            if (c != null) {
                int iAddr = c.getColumnIndex("address");
                int iBody = c.getColumnIndex("body");
                int iDate = c.getColumnIndex("date");
                while (c.moveToNext() && n < max) {
                    JSObject m = new JSObject();
                    m.put("address", iAddr >= 0 ? c.getString(iAddr) : "");
                    m.put("body", iBody >= 0 ? c.getString(iBody) : "");
                    m.put("date", iDate >= 0 ? c.getLong(iDate) : 0L);
                    messages.put(m);
                    n++;
                }
            }
        } catch (Exception e) {
            // permission revoked mid-call, or OEM restriction — return what we have
        } finally {
            if (c != null) c.close();
        }

        JSObject ret = new JSObject();
        ret.put("messages", messages);
        call.resolve(ret);
    }

    @PluginMethod
    public void startWatch(PluginCall call) {
        if (receiver == null) {
            receiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    emitFromIntent(intent);
                }
            };
            IntentFilter filter = new IntentFilter("android.provider.Telephony.SMS_RECEIVED");
            filter.setPriority(999);
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    getContext().registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
                } else {
                    getContext().registerReceiver(receiver, filter);
                }
            } catch (Exception e) {
                receiver = null;
                call.reject("Could not register SMS receiver");
                return;
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void stopWatch(PluginCall call) {
        if (receiver != null) {
            try { getContext().unregisterReceiver(receiver); } catch (Exception ignored) {}
            receiver = null;
        }
        call.resolve();
    }

    /** Reassemble multipart SMS by sender and emit one "smsReceived" event each. */
    private void emitFromIntent(Intent intent) {
        try {
            SmsMessage[] parts = Telephony.Sms.Intents.getMessagesFromIntent(intent);
            if (parts == null || parts.length == 0) return;

            Map<String, StringBuilder> bodies = new HashMap<>();
            Map<String, Long> dates = new HashMap<>();
            for (SmsMessage part : parts) {
                if (part == null) continue;
                String addr = part.getOriginatingAddress();
                if (addr == null) addr = "";
                String body = part.getMessageBody();
                if (body == null) body = "";
                StringBuilder sb = bodies.get(addr);
                if (sb == null) { sb = new StringBuilder(); bodies.put(addr, sb); }
                sb.append(body);
                if (!dates.containsKey(addr)) dates.put(addr, part.getTimestampMillis());
            }

            for (Map.Entry<String, StringBuilder> e : bodies.entrySet()) {
                JSObject sms = new JSObject();
                sms.put("address", e.getKey());
                sms.put("body", e.getValue().toString());
                Long d = dates.get(e.getKey());
                sms.put("date", d != null ? d : System.currentTimeMillis());
                notifyListeners("smsReceived", sms);
            }
        } catch (Exception ignored) {
            // malformed broadcast — ignore
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (receiver != null) {
            try { getContext().unregisterReceiver(receiver); } catch (Exception ignored) {}
            receiver = null;
        }
        super.handleOnDestroy();
    }
}
