import React, { useState, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, doc, setDoc, getDocs, onSnapshot, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';

// --- Environment & Firebase Setup ---
// ⚠️ GitHub Pages等で「オンライン対戦」を動かす場合は、ご自身のFirebaseプロジェクトを作成し、
// 以下の YOUR_API_KEY などを実際の設定値に書き換えてください。
const defaultFirebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};

const appId = typeof __app_id !== 'undefined' ? __app_id : 'my-shogi-app';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : defaultFirebaseConfig;
let app, auth, db;

try {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
} catch (e) {
  console.error("Firebase initialization failed:", e);
}

const BOARD_SIZE = 9;

const PIECE_TYPES = {
  FU: { name: '歩', pro: 'TO', canPromote: true },
  KY: { name: '香', pro: 'NY', canPromote: true },
  KE: { name: '桂', pro: 'NK', canPromote: true },
  GI: { name: '銀', pro: 'NG', canPromote: true },
  KI: { name: '金', pro: null, canPromote: false },
  KA: { name: '角', pro: 'UM', canPromote: true },
  HI: { name: '飛', pro: 'RY', canPromote: true },
  OU: { name: '玉', pro: null, canPromote: false },
  TO: { name: 'と', pro: null, canPromote: false },
  NY: { name: '成香', pro: null, canPromote: false },
  NK: { name: '成桂', pro: null, canPromote: false },
  NG: { name: '成銀', pro: null, canPromote: false },
  UM: { name: '馬', pro: null, canPromote: false },
  RY: { name: '龍', pro: null, canPromote: false },
};

const PIECE_VALUES = {
  FU: 10, KY: 30, KE: 40, GI: 50, KI: 60, KA: 80, HI: 100, OU: 10000,
  TO: 60, NY: 60, NK: 60, NG: 60, UM: 90, RY: 120
};

// Movement vectors: [dx, dy] where dx is x-axis (left/right), dy is y-axis (up/down). 
// Note: Black moves UP (-dy), White moves DOWN (+dy).
const MOVES = {
  FU: [[0, -1]],
  KY: [[0, -1, 'slide']],
  KE: [[-1, -2], [1, -2]],
  GI: [[0, -1], [-1, -1], [1, -1], [-1, 1], [1, 1]],
  KI: [[0, -1], [-1, -1], [1, -1], [-1, 0], [1, 0], [0, 1]],
  KA: [[-1, -1, 'slide'], [1, -1, 'slide'], [-1, 1, 'slide'], [1, 1, 'slide']],
  HI: [[0, -1, 'slide'], [0, 1, 'slide'], [-1, 0, 'slide'], [1, 0, 'slide']],
  OU: [[0, -1], [-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]],
};
// Promoted pieces movement mapped to basic movements
MOVES.TO = MOVES.KI; MOVES.NY = MOVES.KI; MOVES.NK = MOVES.KI; MOVES.NG = MOVES.KI;
MOVES.UM = [...MOVES.KA, [0, -1], [0, 1], [-1, 0], [1, 0]]; // KA slide + 1 step orthogonal
MOVES.RY = [...MOVES.HI, [-1, -1], [1, -1], [-1, 1], [1, 1]]; // HI slide + 1 step diagonal

const LEVELS = ['5級', '4級', '3級', '2級', '1級', '初段', '二段', '三段', '四段', '五段', '六段', '七段', '八段'];

const createInitialBoard = () => {
  const board = Array(9).fill(null).map(() => Array(9).fill(null));
  const setup = [
    { row: 0, pieces: ['KY', 'KE', 'GI', 'KI', 'OU', 'KI', 'GI', 'KE', 'KY'], owner: 'white' },
    { row: 1, pieces: [null, 'HI', null, null, null, null, null, 'KA', null], owner: 'white' },
    { row: 2, pieces: Array(9).fill('FU'), owner: 'white' },
    { row: 6, pieces: Array(9).fill('FU'), owner: 'black' },
    { row: 7, pieces: [null, 'KA', null, null, null, null, null, 'HI', null], owner: 'black' },
    { row: 8, pieces: ['KY', 'KE', 'GI', 'KI', 'OU', 'KI', 'GI', 'KE', 'KY'], owner: 'black' }
  ];

  setup.forEach(s => {
    s.pieces.forEach((type, x) => {
      if (type) board[s.row][x] = { type, owner: s.owner };
    });
  });
  return board;
};

const cloneGameState = (state) => ({
  board: state.board.map(row => row.map(cell => cell ? { ...cell } : null)),
  hands: { black: [...state.hands.black], white: [...state.hands.white] },
  turn: state.turn,
  lastMove: state.lastMove ? { ...state.lastMove } : null
});

const isValidPos = (x, y) => x >= 0 && x < 9 && y >= 0 && y < 9;

const getPseudoLegalMoves = (board, hands, player) => {
  const moves = [];
  const dir = player === 'black' ? 1 : -1;

  // 1. Board Moves
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = board[y][x];
      if (piece && piece.owner === player) {
        const moveVectors = MOVES[piece.type];
        for (let vec of moveVectors) {
          let dx = vec[0];
          let dy = vec[1] * dir;
          let slide = vec[2] === 'slide';
          let nx = x + dx;
          let ny = y + dy;

          while (isValidPos(nx, ny)) {
            const target = board[ny][nx];
            if (!target) {
              moves.push({ from: { x, y }, to: { x: nx, y: ny }, piece: piece.type });
            } else {
              if (target.owner !== player) {
                moves.push({ from: { x, y }, to: { x: nx, y: ny }, piece: piece.type, capture: target.type });
              }
              break; 
            }
            if (!slide) break;
            nx += dx;
            ny += dy;
          }
        }
      }
    }
  }

  // 2. Drops
  const hand = hands[player];
  const uniqueHandPieces = [...new Set(hand)];
  
  for (let type of uniqueHandPieces) {
    for (let y = 0; y < 9; y++) {
      if (type === 'FU' || type === 'KY') {
        if ((player === 'black' && y === 0) || (player === 'white' && y === 8)) continue;
      }
      if (type === 'KE') {
        if ((player === 'black' && y <= 1) || (player === 'white' && y >= 7)) continue;
      }

      for (let x = 0; x < 9; x++) {
        if (!board[y][x]) {
          if (type === 'FU') {
            let hasPawn = false;
            for (let iy = 0; iy < 9; iy++) {
              const p = board[iy][x];
              if (p && p.owner === player && p.type === 'FU') {
                hasPawn = true;
                break;
              }
            }
            if (hasPawn) continue;
          }
          moves.push({ from: null, to: { x, y }, piece: type });
        }
      }
    }
  }

  return moves;
};

const isCheck = (board, player) => {
  let kingPos = null;
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const p = board[y][x];
      if (p && p.owner === player && p.type === 'OU') {
        kingPos = { x, y };
        break;
      }
    }
    if (kingPos) break;
  }
  if (!kingPos) return true;

  const opponent = player === 'black' ? 'white' : 'black';
  const oppMoves = getPseudoLegalMoves(board, { black: [], white: [] }, opponent);
  
  return oppMoves.some(m => m.to.x === kingPos.x && m.to.y === kingPos.y);
};

const getLegalMoves = (state, player) => {
  const pseudoMoves = getPseudoLegalMoves(state.board, state.hands, player);
  const legalMoves = [];

  for (let move of pseudoMoves) {
    const nextState = applyMove(state, move, false);
    if (!isCheck(nextState.board, player)) {
      let mustPromote = false;
      let canPromote = false;
      
      if (move.from) {
        const pType = move.piece;
        const isPromotable = PIECE_TYPES[pType].canPromote;
        const toPromoteZone = (player === 'black' && move.to.y <= 2) || (player === 'white' && move.to.y >= 6);
        const fromPromoteZone = (player === 'black' && move.from.y <= 2) || (player === 'white' && move.from.y >= 6);
        
        if (isPromotable && (toPromoteZone || fromPromoteZone)) {
          canPromote = true;
          if (pType === 'FU' || pType === 'KY') {
            if ((player === 'black' && move.to.y === 0) || (player === 'white' && move.to.y === 8)) mustPromote = true;
          }
          if (pType === 'KE') {
            if ((player === 'black' && move.to.y <= 1) || (player === 'white' && move.to.y >= 7)) mustPromote = true;
          }
        }
      }

      if (mustPromote) {
        legalMoves.push({ ...move, promote: true });
      } else if (canPromote) {
        legalMoves.push({ ...move, promote: true });
        legalMoves.push({ ...move, promote: false });
      } else {
        legalMoves.push({ ...move, promote: false });
      }
    }
  }
  return legalMoves;
};

const applyMove = (state, move, switchTurn = true) => {
  const newState = cloneGameState(state);
  const { from, to, piece, promote } = move;
  const player = state.turn;

  if (from) {
    const target = newState.board[to.y][to.x];
    if (target) {
      const capturedType = target.type;
      const originalType = Object.keys(PIECE_TYPES).find(key => PIECE_TYPES[key].pro === capturedType) || capturedType;
      newState.hands[player].push(originalType);
    }
    newState.board[from.y][from.x] = null;
    newState.board[to.y][to.x] = { type: promote ? PIECE_TYPES[piece].pro : piece, owner: player };
  } else {
    newState.board[to.y][to.x] = { type: piece, owner: player };
    const handIndex = newState.hands[player].indexOf(piece);
    newState.hands[player].splice(handIndex, 1);
  }

  if (switchTurn) {
    newState.turn = player === 'black' ? 'white' : 'black';
    newState.lastMove = { to: { x: to.x, y: to.y } };
  }
  return newState;
};

const evaluateBoard = (state, maximizingPlayer) => {
  let score = 0;
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const p = state.board[y][x];
      if (p) {
        let val = PIECE_VALUES[p.type];
        if (p.owner === 'black') {
          score += val + (8 - y);
        } else {
          score -= val + y;
        }
      }
    }
  }
  state.hands.black.forEach(p => score += PIECE_VALUES[p] * 1.1); 
  state.hands.white.forEach(p => score -= PIECE_VALUES[p] * 1.1);
  
  return maximizingPlayer === 'black' ? score : -score;
};

const calculateAIMove = (state, levelIndex) => {
  const legalMoves = getLegalMoves(state, state.turn);
  if (legalMoves.length === 0) return null;

  const randomChance = Math.max(0, (10 - levelIndex) * 0.08);
  if (Math.random() < randomChance) {
    return legalMoves[Math.floor(Math.random() * legalMoves.length)];
  }

  const maxDepth = levelIndex < 4 ? 1 : levelIndex < 9 ? 2 : 3;
  let bestMove = null;
  let bestValue = -Infinity;

  legalMoves.sort((a, b) => {
    let scoreA = (a.capture ? 10 : 0) + (a.promote ? 5 : 0);
    let scoreB = (b.capture ? 10 : 0) + (b.promote ? 5 : 0);
    return scoreB - scoreA;
  });

  const minimax = (currentState, depth, alpha, beta, isMaximizing) => {
    if (depth === 0) {
      return evaluateBoard(currentState, state.turn);
    }
    
    const moves = getLegalMoves(currentState, currentState.turn);
    if (moves.length === 0) return isMaximizing ? -99999 : 99999; 

    if (isMaximizing) {
      let maxEval = -Infinity;
      for (let m of moves) {
        const nextState = applyMove(currentState, m, true);
        const ev = minimax(nextState, depth - 1, alpha, beta, false);
        maxEval = Math.max(maxEval, ev);
        alpha = Math.max(alpha, ev);
        if (beta <= alpha) break;
      }
      return maxEval;
    } else {
      let minEval = Infinity;
      for (let m of moves) {
        const nextState = applyMove(currentState, m, true);
        const ev = minimax(nextState, depth - 1, alpha, beta, true);
        minEval = Math.min(minEval, ev);
        beta = Math.min(beta, ev);
        if (beta <= alpha) break;
      }
      return minEval;
    }
  };

  for (let move of legalMoves) {
    const nextState = applyMove(state, move, true);
    const noise = Math.random() * 10; 
    const boardValue = minimax(nextState, maxDepth - 1, -Infinity, Infinity, false) + noise;
    
    if (boardValue > bestValue) {
      bestValue = boardValue;
      bestMove = move;
    }
  }

  return bestMove || legalMoves[0];
};

const Modal = ({ isOpen, title, children, onClose }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white text-slate-800 rounded-xl shadow-2xl max-w-md w-full overflow-hidden transform transition-all">
        <div className="bg-amber-600 px-6 py-4 flex justify-between items-center">
          <h3 className="text-lg font-bold text-white">{title}</h3>
          {onClose && (
            <button onClick={onClose} className="text-white hover:text-amber-200 focus:outline-none">
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
        <div className="p-6">
          {children}
        </div>
      </div>
    </div>
  );
};

export default function App() {
  const [user, setUser] = useState(null);
  const [mode, setMode] = useState('menu'); 
  const [cpuLevel, setCpuLevel] = useState(0);
  const [gameState, setGameState] = useState(null);
  const [selectedPos, setSelectedPos] = useState(null);
  const [validMoves, setValidMoves] = useState([]);
  const [pendingPromotion, setPendingPromotion] = useState(null); 
  const [matchId, setMatchId] = useState(null);
  const [playerColor, setPlayerColor] = useState('black');
  const [lobbyMatches, setLobbyMatches] = useState([]);
  const [playerName, setPlayerName] = useState(`Player_${Math.floor(Math.random() * 1000)}`);
  const [winner, setWinner] = useState(null);
  const [isThinking, setIsThinking] = useState(false);

  useEffect(() => {
    if (!auth) return;
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      if (u) setUser(u);
    });
    
    if (typeof __initial_auth_token !== 'undefined') {
      signInWithCustomToken(auth, __initial_auth_token).catch(console.error);
    } else {
      signInAnonymously(auth).catch(console.error);
    }
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (mode === 'playing' && !matchId && gameState && gameState.turn === 'white' && !winner && !pendingPromotion) {
      setIsThinking(true);
      const timer = setTimeout(() => {
        const aiMove = calculateAIMove(gameState, cpuLevel);
        if (aiMove) {
          handleExecuteMove(aiMove);
        } else {
          setWinner('black');
        }
        setIsThinking(false);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [gameState, mode, matchId, winner, pendingPromotion, cpuLevel]);

  useEffect(() => {
    if (!user || !matchId || mode !== 'playing') return;
    const matchRef = doc(db, 'artifacts', appId, 'public', 'data', 'shogi_matches', matchId);
    
    const unsub = onSnapshot(matchRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setGameState(JSON.parse(data.stateJson));
        if (data.winner) setWinner(data.winner);
      } else {
        setMode('menu');
        setMatchId(null);
      }
    }, (error) => {
      console.error("Match snapshot error:", error);
    });
    
    return () => unsub();
  }, [user, matchId, mode]);

  const fetchMatches = async () => {
    if (!user) return;
    const matchesRef = collection(db, 'artifacts', appId, 'public', 'data', 'shogi_matches');
    try {
      const qSnap = await getDocs(matchesRef);
      const openMatches = [];
      qSnap.forEach(d => {
        const m = d.data();
        if (m.status === 'waiting') openMatches.push({ id: d.id, ...m });
      });
      setLobbyMatches(openMatches);
    } catch (e) {
      console.error(e);
    }
  };

  const createMatch = async () => {
    if (!user) return;
    const newMatchId = `match_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const initialState = {
      board: createInitialBoard(),
      hands: { black: [], white: [] },
      turn: 'black',
      lastMove: null
    };
    
    const matchRef = doc(db, 'artifacts', appId, 'public', 'data', 'shogi_matches', newMatchId);
    await setDoc(matchRef, {
      hostId: user.uid,
      hostName: playerName,
      status: 'waiting',
      stateJson: JSON.stringify(initialState),
      createdAt: serverTimestamp()
    });
    
    setPlayerColor('black');
    setMatchId(newMatchId);
    setGameState(initialState);
    setMode('playing');
  };

  const joinMatch = async (id, hostName) => {
    if (!user) return;
    const matchRef = doc(db, 'artifacts', appId, 'public', 'data', 'shogi_matches', id);
    await updateDoc(matchRef, {
      guestId: user.uid,
      guestName: playerName,
      status: 'playing'
    });
    
    setPlayerColor('white');
    setMatchId(id);
    setMode('playing');
  };

  const startCPUGame = (levelIndex) => {
    setCpuLevel(levelIndex);
    setPlayerColor('black');
    setMatchId(null);
    setGameState({
      board: createInitialBoard(),
      hands: { black: [], white: [] },
      turn: 'black',
      lastMove: null
    });
    setWinner(null);
    setMode('playing');
  };

  const handleSquareClick = (x, y) => {
    if (winner || isThinking || (matchId && gameState.turn !== playerColor) || pendingPromotion) return;

    const clickedPiece = gameState.board[y][x];
    const isOwnPiece = clickedPiece && clickedPiece.owner === gameState.turn;

    if (selectedPos) {
      const move = validMoves.find(m => m.to.x === x && m.to.y === y);
      if (move) {
        const isPromotable = PIECE_TYPES[move.piece].canPromote;
        let needsPrompt = false;

        if (move.from && isPromotable) {
          const pType = move.piece;
          const player = gameState.turn;
          const toPromoteZone = (player === 'black' && move.to.y <= 2) || (player === 'white' && move.to.y >= 6);
          const fromPromoteZone = (player === 'black' && move.from.y <= 2) || (player === 'white' && move.from.y >= 6);
          
          let mustPromote = false;
          if (pType === 'FU' || pType === 'KY') {
            if ((player === 'black' && move.to.y === 0) || (player === 'white' && move.to.y === 8)) mustPromote = true;
          }
          if (pType === 'KE') {
            if ((player === 'black' && move.to.y <= 1) || (player === 'white' && move.to.y >= 7)) mustPromote = true;
          }

          if (mustPromote) {
            move.promote = true;
          } else if (toPromoteZone || fromPromoteZone) {
            needsPrompt = true;
          }
        }

        if (needsPrompt) {
          setPendingPromotion(move);
        } else {
          handleExecuteMove(move);
        }
        return;
      }
    }

    if (isOwnPiece) {
      setSelectedPos({ type: 'board', x, y });
      const moves = getLegalMoves(gameState, gameState.turn).filter(m => m.from && m.from.x === x && m.from.y === y);
      setValidMoves(moves);
    } else {
      setSelectedPos(null);
      setValidMoves([]);
    }
  };

  const handleHandClick = (pieceType, owner) => {
    if (winner || isThinking || (matchId && gameState.turn !== playerColor) || pendingPromotion) return;
    if (owner !== gameState.turn) return;

    setSelectedPos({ type: 'hand', piece: pieceType });
    const moves = getLegalMoves(gameState, gameState.turn).filter(m => !m.from && m.piece === pieceType);
    setValidMoves(moves);
  };

  const handleExecuteMove = async (move) => {
    const nextState = applyMove(gameState, move, true);
    const nextLegalMoves = getLegalMoves(nextState, nextState.turn);
    const isMate = nextLegalMoves.length === 0;
    
    setGameState(nextState);
    setSelectedPos(null);
    setValidMoves([]);
    setPendingPromotion(null);

    if (isMate) {
      setWinner(gameState.turn);
    }

    if (matchId && user) {
      const matchRef = doc(db, 'artifacts', appId, 'public', 'data', 'shogi_matches', matchId);
      await updateDoc(matchRef, {
        stateJson: JSON.stringify(nextState),
        winner: isMate ? gameState.turn : null
      });
    } else if (isMate && !matchId) {
      setWinner(gameState.turn);
    }
  };

  const renderPiece = (piece, isFlipped) => {
    if (!piece) return null;
    const isPromoted = ['TO', 'NY', 'NK', 'NG', 'UM', 'RY'].includes(piece.type);
    return (
      <div className={`w-full h-full flex flex-col items-center justify-center font-bold font-serif
        ${isFlipped ? 'rotate-180' : ''} 
        ${isPromoted ? 'text-red-600' : 'text-stone-900'}
        `} style={{
          clipPath: 'polygon(50% 0%, 100% 20%, 90% 100%, 10% 100%, 0% 20%)',
          background: 'linear-gradient(135deg, #f3d79f 0%, #e2b96e 100%)',
          boxShadow: 'inset 0px -2px 4px rgba(0,0,0,0.2)',
          padding: '4px',
          width: '90%', height: '95%'
        }}>
        <span className="text-[1.2rem] leading-tight md:text-2xl drop-shadow-[0_1px_1px_rgba(255,255,255,0.8)]">
          {PIECE_TYPES[piece.type].name}
        </span>
      </div>
    );
  };

  const renderHand = (owner) => {
    const hand = gameState.hands[owner];
    const counts = {};
    hand.forEach(p => counts[p] = (counts[p] || 0) + 1);
    const isOpponentHand = owner !== playerColor;
    
    return (
      <div className={`flex flex-wrap gap-2 p-3 min-h-[80px] bg-stone-800 rounded-lg shadow-inner ${isOpponentHand ? 'rotate-180' : ''}`}>
        {Object.entries(counts).map(([type, count]) => (
          <div 
            key={type}
            onClick={() => !isOpponentHand && handleHandClick(type, owner)}
            className={`relative w-12 h-14 md:w-16 md:h-18 cursor-pointer transform transition-transform 
              ${!isOpponentHand && gameState.turn === owner ? 'hover:-translate-y-1' : ''}
              ${selectedPos?.type === 'hand' && selectedPos.piece === type && !isOpponentHand ? 'ring-2 ring-amber-400 scale-105 rounded' : ''}
            `}
          >
            {renderPiece({ type, owner }, false)}
            {count > 1 && (
              <span className={`absolute -bottom-2 -right-2 bg-red-600 text-white text-xs font-bold rounded-full w-6 h-6 flex items-center justify-center shadow z-10
                ${isOpponentHand ? 'rotate-180' : ''}
              `}>
                {count}
              </span>
            )}
          </div>
        ))}
        {hand.length === 0 && <span className="text-stone-500 italic flex items-center">駒台</span>}
      </div>
    );
  };

  if (mode === 'menu') {
    return (
      <div className="min-h-screen bg-stone-900 flex items-center justify-center p-4 font-sans text-stone-100">
        <div className="max-w-md w-full bg-stone-800 p-8 rounded-2xl shadow-2xl text-center space-y-8 border border-stone-700">
          <h1 className="text-4xl font-extrabold text-amber-500 tracking-widest font-serif drop-shadow-lg">将棋</h1>
          <div className="space-y-4 pt-4">
            <button onClick={() => setMode('cpu_select')} className="w-full py-4 bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 rounded-xl font-bold text-lg shadow-lg transform transition active:scale-95">
              1人プレイ (CPU戦)
            </button>
            <button onClick={() => { setMode('lobby'); fetchMatches(); }} className="w-full py-4 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 rounded-xl font-bold text-lg shadow-lg transform transition active:scale-95">
              オンライン対戦
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (mode === 'cpu_select') {
    return (
      <div className="min-h-screen bg-stone-900 flex items-center justify-center p-4">
        <div className="max-w-3xl w-full bg-stone-800 p-6 md:p-8 rounded-2xl shadow-2xl space-y-6">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-2xl font-bold text-amber-400">難易度選択 (CPU)</h2>
            <button onClick={() => setMode('menu')} className="text-stone-400 hover:text-white px-4 py-2">戻る</button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {LEVELS.map((level, idx) => (
              <button key={level} onClick={() => startCPUGame(idx)} className="py-3 px-2 bg-stone-700 hover:bg-amber-600 rounded-lg font-bold text-stone-200 transition duration-200 shadow border border-stone-600">
                {level}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (mode === 'lobby') {
    return (
      <div className="min-h-screen bg-stone-900 flex flex-col items-center py-10 p-4">
        <div className="max-w-2xl w-full bg-stone-800 p-6 rounded-2xl shadow-2xl space-y-6 text-stone-200">
          <div className="flex justify-between items-center border-b border-stone-700 pb-4">
            <h2 className="text-2xl font-bold text-emerald-400">オンライン対戦ロビー</h2>
            <button onClick={() => setMode('menu')} className="text-stone-400 hover:text-white px-4 py-2 bg-stone-700 rounded shadow">戻る</button>
          </div>
          
          <div className="space-y-2">
            <label className="text-sm text-stone-400">プレイヤー名:</label>
            <input 
              type="text" 
              value={playerName} 
              onChange={e => setPlayerName(e.target.value)} 
              className="w-full p-3 bg-stone-900 border border-stone-700 rounded text-white focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div className="pt-4 space-y-4">
            <button onClick={createMatch} className="w-full py-4 bg-emerald-600 hover:bg-emerald-500 rounded-xl font-bold text-lg shadow-lg">
              対戦部屋を作成する
            </button>
            
            <div className="pt-6">
              <h3 className="text-xl font-semibold mb-4 flex justify-between items-center">
                <span>参加可能な部屋</span>
                <button onClick={fetchMatches} className="text-sm bg-stone-700 px-3 py-1 rounded hover:bg-stone-600">更新</button>
              </h3>
              {lobbyMatches.length === 0 ? (
                <p className="text-stone-500 text-center py-8">現在待機中の部屋はありません。</p>
              ) : (
                <div className="space-y-3">
                  {lobbyMatches.map(m => (
                    <div key={m.id} className="bg-stone-900 p-4 rounded-lg flex justify-between items-center border border-stone-700">
                      <div>
                        <span className="font-bold text-amber-200">{m.hostName}</span>
                        <span className="text-stone-400 text-sm ml-2">の部屋</span>
                      </div>
                      <button onClick={() => joinMatch(m.id, m.hostName)} className="px-6 py-2 bg-amber-600 hover:bg-amber-500 rounded font-bold shadow">
                        参加
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!gameState) return <div className="min-h-screen bg-stone-900 flex items-center justify-center text-white">Loading...</div>;

  const opponentColor = playerColor === 'black' ? 'white' : 'black';
  const isMyTurn = gameState.turn === playerColor;

  return (
    <div className="min-h-screen bg-stone-900 flex flex-col items-center justify-center py-4 px-2 md:px-8 overflow-hidden font-sans select-none">
      
      <div className="w-full max-w-3xl flex justify-between items-center mb-4 text-stone-200">
        <div>
          <button onClick={() => { setMode('menu'); setMatchId(null); }} className="bg-stone-800 px-4 py-2 rounded shadow hover:bg-stone-700 text-sm border border-stone-600">
            投了 / 退出
          </button>
        </div>
        <div className="text-center">
          <div className="text-xl font-bold text-amber-500 flex items-center gap-2">
            {winner ? (
              <span>{winner === playerColor ? 'あなたの勝利！' : 'あなたの敗北...'}</span>
            ) : (
              <>
                <span className={`w-3 h-3 rounded-full ${isMyTurn ? 'bg-emerald-500 animate-pulse' : 'bg-stone-600'}`}></span>
                {isMyTurn ? 'あなたの番です' : (isThinking ? 'CPU思考中...' : '相手の番です')}
              </>
            )}
          </div>
          {matchId && <div className="text-xs text-stone-500 mt-1">オンライン対戦</div>}
          {!matchId && <div className="text-xs text-stone-500 mt-1">CPU戦: {LEVELS[cpuLevel]}</div>}
        </div>
        <div className="w-20"></div>
      </div>

      <div className="flex flex-col md:flex-row gap-4 md:gap-8 items-center w-full max-w-5xl justify-center">
        
        <div className="w-full md:w-32 md:order-1 order-1">
          <div className="text-stone-400 text-sm mb-1">{matchId ? '相手の持駒' : 'CPUの持駒'}</div>
          {renderHand(opponentColor)}
        </div>

        <div className="md:order-2 order-2 shrink-0">
          <div className="bg-[#dcb35c] p-2 md:p-3 rounded-sm shadow-[0_10px_30px_rgba(0,0,0,0.5)] border-4 border-[#8c5a2b]">
            <div className="grid grid-cols-9 gap-px bg-stone-800 border-2 border-stone-800">
              {Array(9).fill(null).map((_, yIndex) => {
                const visualY = playerColor === 'black' ? yIndex : 8 - yIndex;
                return Array(9).fill(null).map((_, xIndex) => {
                  const visualX = playerColor === 'black' ? 8 - xIndex : xIndex; 
                  const cellPiece = gameState.board[visualY][visualX];
                  const isSelected = selectedPos?.type === 'board' && selectedPos.x === visualX && selectedPos.y === visualY;
                  const isValidMoveDest = validMoves.some(m => m.to.x === visualX && m.to.y === visualY);
                  const isLastMove = gameState.lastMove?.x === visualX && gameState.lastMove?.y === visualY;

                  return (
                    <div 
                      key={`${visualX}-${visualY}`}
                      onClick={() => handleSquareClick(visualX, visualY)}
                      className={`
                        w-9 h-[2.5rem] sm:w-12 sm:h-[3.2rem] md:w-[3.5rem] md:h-[4rem] relative flex items-center justify-center cursor-pointer bg-[#e8c678]
                        ${isSelected ? 'bg-amber-300' : ''}
                        ${isLastMove && !isSelected ? 'bg-orange-200/60' : ''}
                      `}
                    >
                      <div className="absolute inset-0 pointer-events-none border border-[#c49a45]/30"></div>
                      
                      {cellPiece && (
                        <div className={`w-full h-full p-[1px] md:p-1 flex justify-center items-center relative z-10 transition-transform ${isSelected ? 'scale-110 -translate-y-1 drop-shadow-xl' : 'drop-shadow-md'}`}>
                           {renderPiece(cellPiece, cellPiece.owner !== playerColor)}
                        </div>
                      )}

                      {isValidMoveDest && (
                         <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
                            <div className="w-3 h-3 md:w-4 md:h-4 rounded-full bg-red-600/70 shadow-sm"></div>
                         </div>
                      )}
                    </div>
                  );
                });
              })}
            </div>
          </div>
        </div>

        <div className="w-full md:w-32 md:order-3 order-3">
          <div className="text-amber-400 font-bold text-sm mb-1">あなたの持駒</div>
          {renderHand(playerColor)}
        </div>

      </div>

      <Modal isOpen={!!pendingPromotion} title="成りますか？">
        <div className="flex gap-4 justify-center py-4">
          <button 
            onClick={() => handleExecuteMove({ ...pendingPromotion, promote: true })}
            className="px-8 py-4 bg-red-600 text-white font-bold rounded shadow-lg hover:bg-red-500 text-xl"
          >
            成る
          </button>
          <button 
            onClick={() => handleExecuteMove({ ...pendingPromotion, promote: false })}
            className="px-8 py-4 bg-stone-600 text-white font-bold rounded shadow-lg hover:bg-stone-500 text-xl"
          >
            成らず
          </button>
        </div>
      </Modal>

      <Modal isOpen={!!winner} title="終局">
        <div className="text-center py-6 space-y-6">
          <h2 className="text-3xl font-bold text-stone-800">
            {winner === playerColor ? '🎉 あなたの勝ち！ 🎉' : '💀 あなたの負け 💀'}
          </h2>
          <button 
            onClick={() => { setMode('menu'); setMatchId(null); setWinner(null); }}
            className="px-6 py-3 bg-amber-600 text-white font-bold rounded shadow-lg hover:bg-amber-500"
          >
            メインメニューに戻る
          </button>
        </div>
      </Modal>
      
    </div>
  );
}
