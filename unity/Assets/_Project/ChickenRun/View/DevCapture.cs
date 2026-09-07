using System;
using UnityEngine;

namespace SkillApp.ChickenRun.View
{
    /// <summary>
    /// Development-only screenshot helper.
    ///
    /// Exists because verifying the game visually from a terminal is otherwise
    /// surprisingly awkward: capturing the desktop grabs whatever window happens
    /// to be in front, and Win32 window-handle capture picked the wrong window
    /// more than once. Unity capturing its own framebuffer is exact and cannot
    /// grab anything that is not the game.
    ///
    /// Inert unless -capture is passed on the command line:
    ///
    ///   ChickenRun.exe -capture out.png -captureAfter 11
    ///
    /// The whole body is compiled out of a release build, so this cannot ship.
    /// </summary>
    public class DevCapture : MonoBehaviour
    {
#if DEVELOPMENT_BUILD || UNITY_EDITOR
        private string _path;
        private float _after = 5f;
        private bool _taken;

        private void Awake()
        {
            var args = Environment.GetCommandLineArgs();
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (args[i] == "-capture") _path = args[i + 1];
                else if (args[i] == "-captureAfter" &&
                         float.TryParse(args[i + 1], out var seconds))
                {
                    _after = seconds;
                }
            }

            if (string.IsNullOrEmpty(_path)) enabled = false;
        }

        private void Update()
        {
            if (_taken || Time.unscaledTime < _after) return;
            _taken = true;

            ScreenCapture.CaptureScreenshot(_path);
            Debug.Log($"[capture] wrote {_path}");

            // CaptureScreenshot finishes at the END of the frame, so quitting in
            // the same frame produces a truncated or missing file. Give it a
            // couple of frames.
            Invoke(nameof(QuitAfterWrite), 0.5f);
        }

        private void QuitAfterWrite() => Application.Quit();
#endif
    }
}
