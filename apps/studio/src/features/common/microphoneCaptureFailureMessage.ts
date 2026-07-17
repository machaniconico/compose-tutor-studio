import { AudioResourceReservationError } from '../../audio/audioResourceReservation';
import { MicrophoneCaptureError } from '../../audio/microphoneCapture';

/** Beginner-facing recovery guidance shared by both melody and Audio Track recording. */
export function microphoneCaptureFailureMessage(error: unknown): string {
  if (error instanceof AudioResourceReservationError) {
    return '別の音声処理が使用中です。処理が終わってから、もう一度録音してください。';
  }
  if (error instanceof MicrophoneCaptureError) {
    switch (error.code) {
      case 'permission-denied':
        return 'マイクの使用が許可されませんでした。OSまたはブラウザの設定でこのアプリのマイクを許可してください。';
      case 'device-not-found':
        return '使用できるマイクが見つかりません。マイクを接続してから再試行してください。';
      case 'device-busy':
      case 'busy':
        return 'マイクがほかの録音処理で使用中です。ほかの録音を終了してから再試行してください。';
      case 'device-ended':
        return '録音中にマイクが切断されました。接続を確認してから再試行してください。';
      case 'insecure-context':
        return 'この接続ではマイクを安全に使用できません。デスクトップ版またはHTTPS版を使用してください。';
      case 'unsupported':
        return 'この環境は直接録音に対応していません。録音済みの音声ファイルを選んでください。';
      case 'too-short':
        return '録音が短すぎます。0.5秒以上、声を伸ばして録音してください。';
      case 'sample-rate-out-of-range':
      case 'channel-limit-exceeded':
        return 'このマイクの音声形式には対応していません。モノラルまたはステレオの別のマイクをお試しください。';
      case 'resource-limit-exceeded':
        return 'この端末では録音用のメモリを安全に確保できませんでした。ほかの音声処理を終了してください。';
      case 'cancelled':
        return '';
      case 'worklet-failed':
      case 'capture-failed':
        break;
    }
  }
  return 'マイク録音を完了できませんでした。接続を確認するか、録音済みファイルを使用してください。';
}
