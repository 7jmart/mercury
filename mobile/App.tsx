import { useCallback, useEffect, useState } from "react";
import {
  SafeAreaView,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  StyleSheet,
} from "react-native";
import { StatusBar } from "expo-status-bar";

import { createRoom, getRoom, joinRoom, leaveRoom, listRooms, sendCode, sendMessage, type RoomDetail, type RoomSummary, type Session, verifyCode } from "./src/api";

export default function App(): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [phoneNumber, setPhoneNumber] = useState("+1");
  const [displayName, setDisplayName] = useState("Friend");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState("Ready.");
  const [debugCode, setDebugCode] = useState<string | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [roomTitle, setRoomTitle] = useState("Quick Friend Room");
  const [currentRoomId, setCurrentRoomId] = useState<string | null>(null);
  const [roomDetail, setRoomDetail] = useState<RoomDetail | null>(null);
  const [message, setMessage] = useState("");

  const loadRooms = useCallback(async () => {
    if (!session) {
      return;
    }

    try {
      const response = await listRooms(session.accessToken);
      setRooms(response);
    } catch (error) {
      setStatus((error as Error).message);
    }
  }, [session]);

  const loadRoomDetail = useCallback(async () => {
    if (!session || !currentRoomId) {
      return;
    }

    try {
      const detail = await getRoom(session.accessToken, currentRoomId);
      setRoomDetail(detail);
    } catch (error) {
      setStatus((error as Error).message);
    }
  }, [currentRoomId, session]);

  useEffect(() => {
    if (!session) {
      return;
    }

    void loadRooms();
    const interval = setInterval(() => {
      void loadRooms();
      void loadRoomDetail();
    }, 4000);

    return () => clearInterval(interval);
  }, [loadRoomDetail, loadRooms, session]);

  const onSendCode = useCallback(async () => {
    try {
      const result = await sendCode(phoneNumber);
      setDebugCode(result.debugCode ?? null);
      setStatus(result.debugCode ? `Code sent. Dev code: ${result.debugCode}` : "Code sent.");
    } catch (error) {
      setStatus((error as Error).message);
    }
  }, [phoneNumber]);

  const onVerify = useCallback(async () => {
    try {
      const nextSession = await verifyCode(phoneNumber, code, displayName);
      setSession(nextSession);
      setStatus(`Logged in as ${nextSession.user.displayName}`);
    } catch (error) {
      setStatus((error as Error).message);
    }
  }, [code, displayName, phoneNumber]);

  const onCreateRoom = useCallback(async () => {
    if (!session) {
      return;
    }

    try {
      await createRoom(session.accessToken, roomTitle);
      setStatus("Room created.");
      await loadRooms();
    } catch (error) {
      setStatus((error as Error).message);
    }
  }, [loadRooms, roomTitle, session]);

  const onJoinRoom = useCallback(async (roomId: string) => {
    if (!session) {
      return;
    }

    try {
      await joinRoom(session.accessToken, roomId);
      setCurrentRoomId(roomId);
      await loadRoomDetail();
      setStatus("Joined room.");
    } catch (error) {
      setStatus((error as Error).message);
    }
  }, [loadRoomDetail, session]);

  const onLeaveRoom = useCallback(async () => {
    if (!session || !currentRoomId) {
      return;
    }

    try {
      await leaveRoom(session.accessToken, currentRoomId);
      setCurrentRoomId(null);
      setRoomDetail(null);
      setStatus("Left room.");
      await loadRooms();
    } catch (error) {
      setStatus((error as Error).message);
    }
  }, [currentRoomId, loadRooms, session]);

  const onSendMessage = useCallback(async () => {
    if (!session || !currentRoomId) {
      return;
    }

    const text = message.trim();
    if (!text) {
      return;
    }

    try {
      await sendMessage(session.accessToken, currentRoomId, text);
      setMessage("");
      await loadRoomDetail();
    } catch (error) {
      setStatus((error as Error).message);
    }
  }, [currentRoomId, loadRoomDetail, message, session]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Mercury Mobile</Text>
        <Text style={styles.subtitle}>{status}</Text>

        {!session ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Phone Login</Text>
            <TextInput style={styles.input} value={phoneNumber} onChangeText={setPhoneNumber} placeholder="+15551234567" />
            <TextInput style={styles.input} value={displayName} onChangeText={setDisplayName} placeholder="Display name" />
            <TextInput style={styles.input} value={code} onChangeText={setCode} placeholder="OTP code" keyboardType="number-pad" />
            <TouchableOpacity style={styles.buttonSecondary} onPress={() => void onSendCode()}>
              <Text style={styles.buttonText}>Send Code</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.buttonPrimary} onPress={() => void onVerify()}>
              <Text style={styles.buttonText}>Verify & Login</Text>
            </TouchableOpacity>
            {debugCode ? <Text style={styles.caption}>Dev code: {debugCode}</Text> : null}
          </View>
        ) : (
          <>
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Create Room</Text>
              <TextInput style={styles.input} value={roomTitle} onChangeText={setRoomTitle} placeholder="Room title" />
              <TouchableOpacity style={styles.buttonPrimary} onPress={() => void onCreateRoom()}>
                <Text style={styles.buttonText}>Create</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Rooms</Text>
              {rooms.map((room) => (
                <TouchableOpacity key={room.roomId} style={styles.roomRow} onPress={() => void onJoinRoom(room.roomId)}>
                  <Text style={styles.roomTitle}>{room.title}</Text>
                  <Text style={styles.caption}>{room.participantCount} online</Text>
                </TouchableOpacity>
              ))}
            </View>

            {currentRoomId && roomDetail ? (
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>{roomDetail.room.title}</Text>
                <TouchableOpacity style={styles.buttonSecondary} onPress={() => void onLeaveRoom()}>
                  <Text style={styles.buttonText}>Leave Room</Text>
                </TouchableOpacity>
                {roomDetail.messages.map((item) => (
                  <View key={item.messageId} style={styles.messageRow}>
                    <Text style={styles.messageMeta}>{item.userId}</Text>
                    <Text>{item.text}</Text>
                  </View>
                ))}
                <TextInput style={styles.input} value={message} onChangeText={setMessage} placeholder="Message" />
                <TouchableOpacity style={styles.buttonPrimary} onPress={() => void onSendMessage()}>
                  <Text style={styles.buttonText}>Send</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#f5fbff",
  },
  container: {
    padding: 16,
    gap: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: "800",
    color: "#102636",
  },
  subtitle: {
    color: "#1d4b63",
    fontWeight: "600",
  },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 14,
    padding: 12,
    gap: 10,
    borderWidth: 1,
    borderColor: "#d7e7f0",
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#102636",
  },
  input: {
    borderWidth: 1,
    borderColor: "#d7e7f0",
    borderRadius: 10,
    padding: 10,
    backgroundColor: "#fff",
  },
  buttonPrimary: {
    backgroundColor: "#dd4a1d",
    borderRadius: 10,
    padding: 10,
    alignItems: "center",
  },
  buttonSecondary: {
    backgroundColor: "#12557a",
    borderRadius: 10,
    padding: 10,
    alignItems: "center",
  },
  buttonText: {
    color: "#fff",
    fontWeight: "700",
  },
  caption: {
    color: "#587789",
    fontSize: 12,
  },
  roomRow: {
    borderWidth: 1,
    borderColor: "#d7e7f0",
    borderRadius: 10,
    padding: 10,
  },
  roomTitle: {
    fontWeight: "700",
    color: "#102636",
  },
  messageRow: {
    borderWidth: 1,
    borderColor: "#d7e7f0",
    borderRadius: 10,
    padding: 8,
    gap: 2,
  },
  messageMeta: {
    fontWeight: "700",
    color: "#102636",
  },
});
