      - name: Extract notes
        run: |
          awk -v v="## v${{ steps.v.outputs.version }}" \
            'index($0,v)==1{f=1;next} /^## /{f=0} f' \
            CHANGELOG.md > notes.md
      - uses: softprops/action-gh-release@v2
        with:
          tag_name: v${{ steps.v.outputs.version }}
          name: v${{ steps.v.outputs.version }}
          body_path: notes.md
