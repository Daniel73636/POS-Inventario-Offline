import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useRef } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

interface Props {
  visible: boolean;
  /** Modo ráfaga: no se cierra tras cada lectura (conteo / venta rápida). */
  burst?: boolean;
  onScan: (code: string) => void;
  onClose: () => void;
}

/** Escáner con cámara: EAN-13, EAN-8, UPC, Code 128 y QR; vibra al leer. */
export function Scanner({ visible, burst, onScan, onClose }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const last = useRef<{ code: string; at: number }>({ code: '', at: 0 });

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.wrap}>
        {!permission?.granted ? (
          <View style={styles.center}>
            <Text style={styles.text}>Se necesita permiso de cámara para escanear.</Text>
            <Pressable style={styles.btn} onPress={requestPermission}><Text style={styles.btnText}>Dar permiso</Text></Pressable>
          </View>
        ) : (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'qr'] }}
            onBarcodeScanned={({ data }) => {
              const now = Date.now();
              if (data === last.current.code && now - last.current.at < 1500) return;
              last.current = { code: data, at: now };
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              onScan(data);
              if (!burst) onClose();
            }}
          />
        )}
        <View style={styles.frame} pointerEvents="none" />
        <Pressable style={[styles.btn, styles.close]} onPress={onClose}><Text style={styles.btnText}>{burst ? 'Terminar' : 'Cerrar'}</Text></Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 },
  text: { color: '#fff', fontSize: 18, textAlign: 'center' },
  frame: { position: 'absolute', left: '10%', right: '10%', top: '35%', height: 160, borderColor: '#14b8a6', borderWidth: 3, borderRadius: 12 },
  btn: { backgroundColor: '#0f766e', paddingVertical: 14, paddingHorizontal: 24, borderRadius: 10 },
  btnText: { color: '#fff', fontSize: 18, fontWeight: '700', textAlign: 'center' },
  close: { position: 'absolute', bottom: 40, left: 24, right: 24 },
});
