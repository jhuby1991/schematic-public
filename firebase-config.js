// Firebase configuration and initialization
const firebaseConfig = {
  apiKey: "AIzaSyCJYVbz38ZWYVutUiYCajNgYHhiX39y-LA",
  authDomain: "rako-system-designer-b7de1.firebaseapp.com",
  projectId: "rako-system-designer-b7de1",
  storageBucket: "rako-system-designer-b7de1.appspot.com",
  messagingSenderId: "447759247794",
  appId: "1:447759247794:web:74a9d739ded00c4fe41cab",
  measurementId: "G-VVJVL4KYHQ"
};

// Initialize Firebase if not already initialized
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
window.auth = firebase.auth();

// Removed Firebase initialization and authentication/firestore references 