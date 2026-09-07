using UnityEngine;

namespace SkillApp.ChickenRun.View
{
    /// <summary>
    /// Insets a UI frame to the device's safe area.
    ///
    /// Without this, the score pill sits under a notch or punch-hole camera on
    /// most modern Android phones, and the Cash Out egg can land under the
    /// gesture bar — where the OS eats the touch and the button appears broken.
    ///
    /// It also matters for the React Native embed specifically: the Unity view is
    /// a child of an RN screen and can be resized by the host at any time, so the
    /// safe area is re-read whenever the screen dimensions change rather than
    /// being sampled once at startup.
    /// </summary>
    [RequireComponent(typeof(RectTransform))]
    public class SafeAreaFrame : MonoBehaviour
    {
        private RectTransform _rect;
        private Rect _lastSafeArea;
        private Vector2Int _lastScreen;

        private void Awake()
        {
            _rect = GetComponent<RectTransform>();
            Apply();
        }

        private void Update()
        {
            // Cheap comparison every frame beats a resize the layout never
            // notices. Screen.safeArea changes on rotation, on a foldable
            // unfolding, and when the host view is resized.
            if (Screen.safeArea == _lastSafeArea &&
                Screen.width == _lastScreen.x &&
                Screen.height == _lastScreen.y)
            {
                return;
            }
            Apply();
        }

        private void Apply()
        {
            if (_rect == null) return;

            var safe = Screen.safeArea;
            _lastSafeArea = safe;
            _lastScreen = new Vector2Int(Screen.width, Screen.height);

            // Guard against a zero-sized screen, which happens for a frame while
            // the host view is being laid out and would otherwise divide by zero
            // and collapse the whole HUD.
            if (Screen.width <= 0 || Screen.height <= 0) return;

            var min = new Vector2(safe.xMin / Screen.width, safe.yMin / Screen.height);
            var max = new Vector2(safe.xMax / Screen.width, safe.yMax / Screen.height);

            _rect.anchorMin = min;
            _rect.anchorMax = max;
            _rect.offsetMin = Vector2.zero;
            _rect.offsetMax = Vector2.zero;
        }
    }
}
